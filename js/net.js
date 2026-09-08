// net.js —— P2P 网络层（PeerJS / WebRTC DataChannel）
// 星型拓扑：房主为权威主机；客户端全部连接主机。
// 特性：自动重连（会话凭据）、主机掉线迁移（最低座位存活者接任）、心跳检测。
'use strict';

import { Engine } from './rules.js';
import { uid, delay } from './util.js';

const PEER_PREFIX = 'catcard-';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const DEFAULT_SIGNAL = null; // null => 官方云信令 0.peerjs.com

const ICE = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  {
    urls: ['turn:openrelay.metered.ca:80', 'turn:openrelay.metered.ca:443'],
    username: 'openrelayproject', credential: 'openrelayproject',
  },
];

export function genRoomCode(len = 5) {
  let out = '';
  for (let i = 0; i < len; i++) out += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return out;
}

export function hostPeerId(roomId, attempt) {
  return PEER_PREFIX + roomId.toLowerCase() + '-h' + attempt;
}

// 解析 URL: ?room=...&signal=host:port(/path)&name=...
export function parseUrl() {
  const q = new URLSearchParams(location.search);
  return {
    room: (q.get('room') || '').toUpperCase().slice(0, 5),
    name: q.get('name') || '',
    signal: q.get('signal') || null,
  };
}

function peerOptions(signal) {
  const opts = {
    debug: 0,
    config: { iceServers: ICE },
  };
  if (signal) {
    // signal 形如 host:port 或 host:port/path
    const m = signal.match(/^([^:/]+):(\d+)(\/.*)?$/);
    if (m) {
      opts.host = m[1];
      opts.port = parseInt(m[2], 10);
      if (m[3]) opts.path = m[3];
    }
  }
  return opts;
}

export class GameNet {
  /**
   * callbacks: {
   *   onSync(state)          —— 完整状态（truth，含 events 批次）
   *   onStatus(status, info)—— connecting/online/reconnecting/error/hostdown/bye
   *   onLocal(state)         —— 本机是主机时，本地 UI 的状态同步
   * }
   */
  constructor(callbacks) {
    this.cb = callbacks;
    this.acl = null;   // 大厅/游戏回调由外部注入

    this.peer = null;
    this.conn = null;       // 客户端：与主机的连接
    this.engine = null;     // 主机：规则引擎
    this.conns = new Map(); // 主机：playerId -> {conn, lastSeen}

    this.roomId = null;
    this.mySeat = -1;
    this.myId = null;
    this.isHost = false;
    this.amHosting = false;

    this.lastState = null;
    this.lastPongAt = 0;
    this.hostLost = false;
    this.hostAttempt = 1;

    this.timers = [];
    this.desiredHost = null; // 迁移目标 peer id
    this.reconnectTimer = null;
    this.migrating = false;

    this.signal = null;
  }

  // ---------- 客户端: 创建房间 ----------
  async createRoom(name, settings) {
    const code = genRoomCode();
    await this.becomeHost(code, name, settings);
    return { code };
  }

  // ---------- 主机初始化（建房间 / 迁移接任）----------
  async becomeHost(code, name = null, settings = null, state = null) {
    const attempt = (state && state.app && state.app.attempt || 0) + 1;
    this.roomId = code;
    this.isHost = true;
    this.hostAttempt = attempt;
    const hpid = hostPeerId(code, attempt);

    if (state) {
      // 迁移接任：从最后一个已知状态继续
      this.engine = new Engine(state);
      const s = this.engine.state;
      s.app = { ...(s.app || {}), hostPeerId: hpid, hostSeat: this.mySeat, attempt };
      s.players.forEach(p => { p.connected = p.seat === this.mySeat; });
      this.engine.commit();
      this.broadcast();
      this.emitLocal();
    } else {
      // 首次建房
      this.myId = uid();
      this.mySeat = 0;
      this.engine = new Engine();
      this.engine.initMatch(code, settings, [{ id: this.myId, name: name || '房主', connected: true }]);
      const s = this.engine.state;
      s.app = { hostPeerId: hpid, hostSeat: 0, attempt };
      s.players[0].peerId = this.myId;
      this.engine.commit();
      this.emitLocal();
    }

    this.destroyPeer();
    await this.openPeer(hpid);
    this.amHosting = true;
    this.cb.onStatus('online', 'host');
    this.startHostTick();
  }

  openPeer(id) {
    return new Promise((resolve, reject) => {
      const p = new Peer(id, peerOptions(this.signal));
      let settled = false;
      p.on('open', () => {
        if (!settled) {
          settled = true;
          this.peer = p;
          this.setupPeerHandlers();
          resolve(p);
        }
      });
      p.on('error', (err) => {
        console.warn('[net] peer error', err.type, err);
        if (!settled && !['network', 'disconnected', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
          settled = true;
          reject(err);
        }
      });
      setTimeout(() => { if (!settled) reject(new Error('peer open timeout')); }, 20000);
    });
  }

  setupPeerHandlers() {
    const p = this.peer;
    p.on('connection', (conn) => this.onIncoming(conn));
    p.on('disconnected', () => { if (!p.destroyed) { try { p.reconnect(); } catch (e) { /* noop */ } } });
    p.on('error', (err) => {
      if (err.type === 'unavailable-id') { /* 迁移竞态，稍后重试 */ }
    });
  }

  destroyPeer() {
    if (this.peer) { try { this.peer.destroy(); } catch (e) { /* noop */ } this.peer = null; }
  }

  setSignal(sig) { this.signal = sig; if (this.peer) { this.destroyPeer(); } }

  // ---------- 主机: 收到连接 ----------
  onIncoming(conn) {
    conn.on('open', () => {});
    conn.on('data', (msg) => this.onHostMessage(conn, msg));
    conn.on('close', () => {
      // 连接断开但玩家可能很快回归，交给 tick 判定
    });
    conn.on('error', () => {});
  }

  onHostMessage(conn, msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'hello': this.onHello(conn, msg); break;
      case 'ping': {
        try { conn.send({ t: 'pong', ts: msg.ts }); } catch (e) { /* noop */ }
        const rec = [...this.conns.values()].find(r => r.conn === conn);
        if (rec) rec.lastSeen = Date.now();
        if (rec) { const p = this.engine.state.players.find(pl => pl.id === rec.playerId); if (p && !p.connected) this.setConnected(p.seat, true); }
        break;
      }
      case 'act': this.onAct(conn, msg); break;
      case 'statePush': {
        // 迁移竞态：别的客户端持有更新的状态
        if (this.engine && msg.state && msg.state.v > this.engine.state.v) {
          this.engine = new Engine(msg.state);
          const s = this.engine.state;
          s.app = { ...(s.app || {}), hostPeerId: hostPeerId(this.roomId, this.hostAttempt), hostSeat: this.mySeat, attempt: this.hostAttempt };
          this.broadcast();
        }
        break;
      }
    }
  }

  onHello(conn, msg) {
    const s = this.engine.state;
    let p = null;
    if (msg.playerId) {
      p = s.players.find(pl => pl.id === msg.playerId);
      // lobby 阶段玩家对象可能已被移除
      if (!p) p = null;
    }
    if (!p) {
      if (s.phase !== 'lobby') { try { conn.send({ t: 'err', msg: '对局已开始，无法加入' }); } catch (e) {} return; }
      if (s.players.length >= 4) { try { conn.send({ t: 'err', msg: '房间已满' }); } catch (e) {} return; }
      const added = this.engine.addPlayer({ id: msg.playerId || uid(), name: (msg.name || '玩家').slice(0, 12) });
      if (!added) { try { conn.send({ t: 'err', msg: '加入失败' }); } catch (e) {} return; }
      p = added;
    }
    if (p.seat !== this.mySeat) {
      // 重复连接：替换旧连接
      const old = [...this.conns.values()].find(r => r.playerId === p.id);
      if (old) { try { old.conn.close(); } catch (e) {} }
    }
    this.conns.set(p.id, { conn, playerId: p.id, lastSeen: Date.now() });
    if (p.seat === this.mySeat) this.conns.delete(p.id); // 自己不需要网络连接
    p.connected = true;
    p.peerId = msg.playerId || p.id;
    this.engine.commit();
    this.broadcast();
    try { conn.send({ t: 'welcome', playerId: p.id, selfSeat: p.seat, state: this.engine.state }); } catch (e) {}
    if (msg.lastV && msg.lastV > this.engine.state.v) {
      try { conn.send({ t: 'needState' }); } catch (e) {}
    }
  }

  setConnected(seat, ok) {
    const s = this.engine.state;
    const p = s.players[seat];
    if (p) p.connected = ok;
    this.engine.evPush('conn', { seat, ok });
    this.engine.commit();
    this.broadcast();
    this.emitLocal();
  }

  // ---------- 主机: 行动路由 ----------
  onAct(conn, msg) {
    if (!this.engine) return;
    const p = this.engine.state.players.find(pl => pl.id === msg.playerId);
    if (!p) { try { conn.send({ t: 'err', msg: '未知玩家' }); } catch (e) {} return; }
    const seat = p.seat;
    const type = msg.type;
    const pl = msg.payload || {};
    const reply = (r) => {
      if (r && !r.ok && r.error) { try { conn.send({ t: 'err', msg: r.error }); } catch (e) {} }
    };
    switch (type) {
      case 'ready': reply(this.engine.setReady(seat, !!pl.ready)); break;
      case 'settings': reply(this.engine.setSettings(seat, pl.settings || {})); break;
      case 'start':
        if (seat !== this.engine.state.hostSeat) { reply({ ok: false, error: '只有房主可以开始' }); return; }
        reply(this.engine.startMatch());
        break;
      case 'arrange': reply(this.engine.arrange(seat, pl.a, pl.b)); break;
      case 'arrangeDone': reply(this.engine.arrangeDone(seat)); break;
      case 'direction': reply(this.engine.chooseDirection(seat, pl.dir)); break;
      case 'play': reply(this.engine.actPlay(seat, pl.cardId, pl.targets || {})); break;
      case 'wild': reply(this.engine.chooseWild(seat, pl.color, pl.point)); break;
      case 'wildCancel': reply(this.engine.cancelWild(seat)); break;
      case 'pass': reply(this.engine.actPass(seat, pl.slot)); break;
      case 'cover': reply(this.engine.actCover(seat, pl.slot)); break;
      case 'guess': reply(this.engine.actGuess(seat, pl.targetSeat, pl.colors, pl.discardIds)); break;
      case 'counter': reply(this.engine.actCounter(seat, pl.payload || { decline: true })); break;
      case 'rematch': if (seat === this.engine.state.hostSeat) reply(this.engine.rematch()); break;
      case 'backLobby': if (seat === this.engine.state.hostSeat) reply(this.engine.backToLobby()); break;
      case 'leave': this.handleLeave(seat); break;
      default: reply({ ok: false, error: '未知动作' });
    }
    this.broadcast();
    this.emitLocal();
  }

  handleLeave(seat) {
    const s = this.engine.state;
    if (s.phase === 'lobby') {
      this.engine.removePlayer(seat);
      this.broadcast();
      this.emitLocal();
    } else {
      // 对局中：直接判负退场
      this.engine.removePlayer(seat);
      this.engine.eliminate(seat, 'leave');
      this.broadcast();
      this.emitLocal();
    }
  }

  // 主机本地行动（房主自己的操作不用走网络）
  localAct(type, payload = {}) {
    const seat = this.mySeat;
    const s = this.engine.state;
    switch (type) {
      case 'ready': return this.engine.setReady(seat, !!payload.ready);
      case 'settings': return this.engine.setSettings(seat, payload.settings || {});
      case 'start': return this.engine.startMatch();
      case 'arrange': return this.engine.arrange(seat, payload.a, payload.b);
      case 'arrangeDone': return this.engine.arrangeDone(seat);
      case 'direction': return this.engine.chooseDirection(seat, payload.dir);
      case 'play': return this.engine.actPlay(seat, payload.cardId, payload.targets || {});
      case 'wild': return this.engine.chooseWild(seat, payload.color, payload.point);
      case 'wildCancel': return this.engine.cancelWild(seat);
      case 'pass': return this.engine.actPass(seat, payload.slot);
      case 'cover': return this.engine.actCover(seat, payload.slot);
      case 'guess': return this.engine.actGuess(seat, payload.targetSeat, payload.colors, payload.discardIds);
      case 'counter': return this.engine.actCounter(seat, payload.payload || { decline: true });
      case 'rematch': return this.engine.rematch();
      case 'backLobby': return this.engine.backToLobby();
      case 'leave': { this.leaveRoom(); return { ok: true }; }
    }
    return { ok: false, error: '未知动作' };
  }

  broadcast() {
    if (!this.engine) return;
    const state = this.engine.state;
    const msg = { t: 'sync', state };
    for (const [, rec] of this.conns) {
      if (rec.conn.open) { try { rec.conn.send(msg); } catch (e) { /* noop */ } }
    }
  }

  emitLocal() {
    if (this.engine && this.cb.onSync) this.cb.onSync(this.engine.state);
  }

  // ---------- 主机定时任务 ----------
  startHostTick() {
    this.timers.push(setInterval(() => this.hostTick(), 1000));
  }

  hostTick() {
    if (!this.isHost || !this.engine) return;
    const s = this.engine.state;
    const now = Date.now();
    let changed = this.lastV !== s.v;
    for (const [pid, rec] of this.conns) {
      const p = s.players.find(pl => pl.id === pid);
      if (!p) continue;
      if (now - rec.lastSeen > 15000 && p.connected) {
        this.setConnected(p.seat, false);
        this.logDrop(p.seat);
      }
      if (!p.connected && now - rec.lastSeen > 75000) {
        // 掉线过久 → 淘汰 / 移除
        if (s.phase === 'lobby') {
          this.engine.removePlayer(p.seat);
          this.conns.delete(pid);
          rec.conn.close();
        } else if (!p.eliminated) {
          this.engine.say(p.seat, '掉线过久，被移出对局');
          this.engine.eliminate(p.seat, 'dc');
          this.conns.delete(pid);
        }
      }
    }
    // 摆猫/选方向阶段自动补做
    if (s.phase === 'arrange') {
      for (const seat of [...s.pending.arrange]) {
        const p = s.players[seat];
        if (p && !p.connected && !p.eliminated) this.engine.arrangeDone(seat);
      }
    }
    if (s.phase === 'direction') {
      const seat = s.round === 1 ? 0 : null;
      const p = seat != null ? s.players[seat] : null;
      if (p && !p.connected) this.engine.chooseDirection(seat, 1);
    }
    // 万能牌待选兜底：选牌者掉线/被淘汰则自动取消，避免全场卡在等待
    if (s.pending && s.pending.wild) {
      const wp = s.players[s.pending.wild.seat];
      if (wp && (wp.eliminated || !wp.connected)) {
        this.engine.cancelWild(wp.seat);
        this.engine.say(wp.seat, '连接中断，取消了万能牌选择');
      }
    }
    if (this.lastV !== s.v || changed) this.broadcast();
    if (this.lastV !== s.v || changed) this.emitLocal();
    this.lastV = s.v;
  }

  logDrop(seat) {
    this.engine.say(seat, '断开了连接');
    this.broadcast();
    this.emitLocal();
  }

  // ---------- 客户端: 加入房间 ----------
  async joinRoom(code, name) {
    this.roomId = code.toUpperCase();
    const session = this.loadSession();
    this.myId = session && session.roomId === this.roomId ? session.playerId : null;
    this.myName = name;
    this.cb.onStatus('connecting', '查找房间…');
    await this.connectLoop(1, true);
  }

  loadSession() {
    try {
      const raw = localStorage.getItem('catcard-session');
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  saveSession() {
    try {
      localStorage.setItem('catcard-session', JSON.stringify({ roomId: this.roomId, playerId: this.myId, name: this.myName }));
    } catch (e) { /* noop */ }
  }

  publicPeerId(attempt) {
    return hostPeerId(this.roomId, this.hostAttempt === 0 ? 1 : this.hostAttempt);
  }

  async connectLoop(attempt, first = false) {
    if (this.amHosting || this.migrating) return;
    const pid = hostPeerId(this.roomId, attempt);
    this.hostAttempt = attempt;
    this.destroyPeer();
    try {
      // 全新 peer（随机 id），用于连入房间
      await this.openPeer(uid());
    } catch (e) {
      this.cb.onStatus('error', 'P2P 初始化失败：' + e.message);
      return;
    }
    this.isHost = false;
    const conn = this.peer.connect(pid, { reliable: true, serialization: 'json', metadata: { name: this.myName } });
    this.conn = conn;
    const joined = new Promise((resolve) => {
      conn.on('open', () => {
        conn.send({ t: 'hello', name: this.myName, playerId: this.myId, lastV: this.lastState ? this.lastState.v : 0 });
        resolve(true);
      });
      conn.on('error', () => resolve(false));
      setTimeout(() => resolve(false), 8000);
    });
    if (!await joined) {
      // 连接失败：重试几次后判定主机掉线 → 迁移
      if (first) this.cb.onStatus('reconnecting', '正在连接主机…');
      if (Date.now() - this.joinStart < 60000) {
        this.reconnectTimer = setTimeout(() => this.connectLoop(attempt, false), 2000);
        return;
      }
      this.cb.onStatus('hostdown', '主机不在线');
      return;
    }
    this.bindClientConn(conn, pid);
  }

  bindClientConn(conn, pid) {
    this.conn = conn;
    this.lastPongAt = Date.now();
    conn.on('data', (msg) => this.onClientMessage(conn, pid, msg));
    conn.on('close', () => this.onConnLost(pid));
    conn.on('error', () => this.onConnLost(pid));
    this.startClientTick();
  }

  onConnLost(pid) {
    if (this.amHosting) return;
    if (this.hostLost) return;
    this.cb.onStatus('reconnecting', '连接断开，重连中…');
    this.joinStart = Date.now();
    // 先快速重试当前主机（可能是瞬时网络抖动）
    this.reconnectTimer = setTimeout(() => this.connectLoop(this.hostAttempt, false), 1500);
  }

  onClientMessage(conn, pid, msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'welcome': {
        this.myId = msg.playerId;
        this.mySeat = msg.selfSeat;
        this.myName = this.myName || msg.state.players[msg.selfSeat].name;
        this.saveSession();
        this.lastPongAt = Date.now();
        this.cb.onStatus('online', 'joined');
        this.acceptState(msg.state);
        break;
      }
      case 'sync': {
        this.lastPongAt = Date.now();
        this.acceptState(msg.state);
        break;
      }
      case 'pong': this.lastPongAt = Date.now(); break;
      case 'err': if (this.cb.onErr) this.cb.onErr(msg.msg); break;
      case 'needState': {
        if (this.lastState) { try { conn.send({ t: 'statePush', state: this.lastState }); } catch (e) {} }
        break;
      }
    }
  }

  acceptState(state) {
    // 只接受更新的状态
    if (this.lastState && state.v && state.v <= this.lastState.v) return;
    this.lastState = JSON.parse(JSON.stringify(state));
    // 若自己是迁移后接任的新主机，说明它还在客户端模式残留
    if (this.amHosting) return;
    if (this.cb.onSync) this.cb.onSync(state);
  }

  // 客户端心跳：失去主机 → 迁移
  startClientTick() {
    this.timers.push(setInterval(() => this.clientTick(), 2000));
  }

  clientTick() {
    if (this.amHosting || !this.conn) return;
    if (this.conn.open) {
      try { this.conn.send({ t: 'ping', ts: Date.now() }); } catch (e) { /* noop */ }
    }
    if (Date.now() - this.lastPongAt > 14000 && !this.hostLost) {
      this.migrate();
    }
  }

  // ---------- 主机迁移 ----------
  migrate() {
    if (!this.lastState) return;
    this.hostLost = true;
    const st = this.lastState;
    const oldHostSeat = st.app ? st.app.hostSeat : st.hostSeat;
    const alive = st.players.filter(p => !p.eliminated && p.seat !== oldHostSeat);
    if (alive.length === 0) {
      this.cb.onStatus('hostdown', '主机掉线且无人可接替');
      return;
    }
    const elect = alive.sort((a, b) => a.seat - b.seat)[0].seat;
    if (elect === this.mySeat) {
      this.cb.onStatus('reconnecting', '主机掉线，你将成为新主机…');
      this.migrating = true;
      this.isHost = true;
      this.amHosting = true;
      const nextAttempt = (st.app && st.app.attempt || 1) + 1;
      this.hostAttempt = nextAttempt;
      this.destroyPeer();
      const code = this.roomId;
      this.engine = new Engine(st);
      const s = this.engine.state;
      s.app = { ...(s.app || {}), hostPeerId: hostPeerId(code, nextAttempt), hostSeat: this.mySeat, attempt: nextAttempt };
      s.players.forEach(p => { p.connected = p.seat === this.mySeat; });
      this.engine.commit();
      this.emitLocal();
      this.openPeer(hostPeerId(code, nextAttempt)).then(() => {
        this.cb.onStatus('online', 'migrated-host');
        this.startHostTick();
      }).catch(() => {
        this.cb.onStatus('hostdown', '接任主机失败');
      });
    } else {
      // 等待新主机（确定性 ID：attempt+1）
      this.cb.onStatus('reconnecting', '主机掉线，正在迁移…');
      this.joinStart = Date.now();
      this.hostLost = false;
      this.reconnectTimer = setTimeout(() => this.connectLoop((st.app && st.app.attempt || 1) + 1, true), 800);
    }
  }

  // ---------- 客户端发送行动 ----------
  act(type, payload) {
    if (this.amHosting && !this.conn) {
      // 主机本地行动：立即广播并反馈错误
      const r = this.localAct(type, payload);
      if (r && !r.ok && r.error && this.cb.onErr) this.cb.onErr(r.error);
      this.broadcast();
      this.emitLocal();
      return;
    }
    if (!this.conn || !this.conn.open) { if (this.cb.onErr) this.cb.onErr('未连接到主机'); return; }
    try { this.conn.send({ t: 'act', playerId: this.myId, type, payload }); } catch (e) { /* noop */ }
  }

  // 主机身份但通过 conn 与外界通信的场景不存在；主机直接用 localAct

  leaveRoom() {
    if (this.amHosting) {
      this.cb.onStatus('bye', '房间已解散');
    } else if (this.conn && this.conn.open) {
      try { this.conn.send({ t: 'act', playerId: this.myId, type: 'leave', payload: {} }); } catch (e) {}
    }
    this.destroy();
  }

  destroy() {
    this.timers.forEach(t => clearInterval(t));
    this.timers = [];
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.destroyPeer();
    this.amHosting = false;
    this.isHost = false;
    this.conn = null;
    this.engine = null;
    this.conns.clear();
  }
}