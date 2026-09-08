// rules.js —— 纯规则引擎（无 DOM 依赖），主机权威执行
'use strict';

import { buildMainDeck, buildCatDeck, canPlayOn, cardName, catName,
         WHITE, BLACK, GRAY, FUNC_DRAW, FUNC_PEEK, FUNC_SWAP, FUNC_PROTECT, FUNC_MUTE } from './cards.js';
import { shuffle, nextAliveSeat, livingPlayers, seatName, neighborSeats, uid } from './util.js';

export class Engine {
  // settings: { extraCats2or3, handCatRule, protectOthers, eliminationMode }
  constructor(state = null) {
    if (state) { this.s = JSON.parse(JSON.stringify(state)); }
    else {
      this.s = {
        v: 0, roomId: '', phase: 'lobby', settings: {},
        players: [], direction: 1, currentSeat: 0, round: 0,
        deck: [], discard: [], lastCard: null, catDeck: [],
        pending: { arrange: [], wild: null, counter: null },
        turnCoverUsed: false, winnerSeat: -1, eliminatedSeat: -1,
        events: [], log: [], hostSeat: 0, hostAttempt: 1,
      };
    }
    this.ev = [];
    this.log = Array.isArray(this.s.log) ? this.s.log.slice() : [];
  }

  get state() { return this.s; }

  evPush(type, data) { this.ev.push({ t: type, ...data }); return this.ev; }

  say(seat, text) {
    this.log.push(`${seatName(this.s, seat)} ${text}`);
    this.evPush('say', { seat, text: `${seatName(this.s, seat)} ${text}` });
  }

  // ---------- 匹配与开局 ----------
  // playersMeta: [{name}] —— 建房间时座位即加入顺序
  initMatch(roomId, settings, playersMeta) {
    const s = this.s;
    s.roomId = roomId;
    s.settings = settings;
    s.players = playersMeta.map((m, i) => ({
      id: m.id, name: m.name, seat: i, peerId: null, connected: m.connected !== false,
      hand: [], handCat: null, cats: [], silenceMarkers: [],
      eliminated: false, wonByGuessLastRound: false, ready: false,
    }));
    s.round = 0;
    s.direction = 1;
  }

  addPlayer(meta) {
    const s = this.s;
    if (s.players.length >= 4) return null;
    const p = {
      id: meta.id, name: meta.name, seat: s.players.length, peerId: null,
      connected: true, hand: [], handCat: null, cats: [], silenceMarkers: [],
      eliminated: false, wonByGuessLastRound: false, ready: false,
    };
    s.players.push(p);
    this.evPush('join', { seat: p.seat, name: p.name });
    return p;
  }

  removePlayer(seat) {
    const s = this.s;
    const p = s.players[seat];
    if (!p) return;
    if (s.phase === 'lobby') {
      s.players.splice(seat, 1);
      s.players.forEach((q, i) => q.seat = i);
      this.evPush('leave', { seat, name: p.name });
      this.commit();
    } else {
      // 对局中：标记断线（由网络层决定是否淘汰）
      p.connected = false;
      this.evPush('drop', { seat, name: p.name });
      this.commit();
    }
  }

  // 2/3 人规则开关结算
  catCount() {
    const n = livingPlayers(this.s).length;
    return (n <= 3 && this.s.settings.extraCats2or3) ? 4 : 3;
  }
  useHandCatRule() {
    const n = livingPlayers(this.s).length;
    return n <= 3 && this.s.settings.handCatRule;
  }

  // 开始第一局
  startMatch() {
    const s = this.s;
    if (s.phase !== 'lobby' || livingPlayers(s).length < 2) return { ok: false, error: '至少需要 2 名玩家' };
    for (const p of s.players) if (p.seat !== s.hostSeat && !p.ready) return { ok: false, error: '有玩家尚未准备' };
    s.players.forEach(p => { p.eliminated = false; p.wonByGuessLastRound = false; });
    s.direction = 1;
    s.round = 0;
    this.startRound();
    return { ok: true };
  }

  startRound() {
    const s = this.s;
    s.round += 1;
    s.deck = buildMainDeck();
    s.catDeck = buildCatDeck();
    s.discard = [];
    s.lastCard = null;
    s.pending = { arrange: [], wild: null, counter: null };
    s.turnCoverUsed = false;
    s.winnerSeat = -1;
    s.eliminatedSeat = -1;
    const alive = s.players.filter(p => !p.eliminated);
    const cc = this.catCount();
    const handCatOn = this.useHandCatRule();
    for (const p of alive) {
      p.hand = [];
      p.handCat = null;
      p.cats = [];
      p.silenceMarkers = [];
      for (let i = 0; i < cc; i++) {
        p.cats.push({ base: s.catDeck.pop(), baseRevealed: false, cover: null, coverRevealed: false, protected: false, protectTrigger: null });
      }
      if (handCatOn) p.handCat = s.catDeck.pop();
      let initial = 8 + (s.round > 1 && p.wonByGuessLastRound ? 1 : 0);
      p.wonByGuessLastRound = false;
      this.draw(p.seat, initial);
    }
    // 初始牌（避免灰色万能牌）
    let first = s.deck.pop();
    while (first && first.type === 'wild') {
      s.deck.unshift(first);
      first = s.deck.pop();
    }
    s.discard.push(first);
    s.lastCard = first;
    // 新回合起始座位；第 1 回合为 1 号位（座位 0），其后为被淘汰者沿出牌顺序的下一位
    if (s.round === 1) {
      s.currentSeat = alive[0].seat;
      s.pending.arrange = alive.map(p => p.seat);
      s.phase = 'arrange';
      this.evPush('round', { round: s.round, seats: alive.map(p => p.seat) });
      this.evPush('phase', { phase: 'arrange' });
      this.evPush('deckinfo', { deckCount: s.deck.length });
      this.evPush('flip', { card: first });
    } else {
      const next = nextAliveSeat(s, s.eliminatedSeat, s.direction);
      s.currentSeat = next;
      s.phase = 'arrange';
      s.pending.arrange = alive.map(p => p.seat);
      this.evPush('round', { round: s.round, seats: alive.map(p => p.seat) });
      this.evPush('phase', { phase: 'arrange' });
      this.evPush('deckinfo', { deckCount: s.deck.length });
      this.evPush('flip', { card: first });
    }
    if (s.round === 1) {
      s.pending.direction = s.players[0].seat; // 一号位选择出牌顺序
    }
    this.commit();
    return { ok: true };
  }

  // 摆猫：交换自己的两张猫牌位置（增量语义：交换“当前”数组的 a、b 两位，快速连续交换天然正确）
  arrange(seat, a, b) {
    const s = this.s;
    if (s.phase !== 'arrange' || !s.pending.arrange.includes(seat)) return { ok: false, error: '未在摆猫阶段' };
    const p = s.players[seat];
    if (!p || p.eliminated) return { ok: false, error: '无效玩家' };
    if (!Number.isInteger(a) || !Number.isInteger(b) || a === b ||
        a < 0 || b < 0 || a >= p.cats.length || b >= p.cats.length) return { ok: false, error: '交换位置无效' };
    const t = p.cats[a]; p.cats[a] = p.cats[b]; p.cats[b] = t;
    this.evPush('arrange', { seat, a, b });
    this.commit();
    return { ok: true };
  }

  arrangeDone(seat) {
    const s = this.s;
    if (s.phase !== 'arrange' || !s.pending.arrange.includes(seat)) return { ok: false, error: '未在摆猫阶段' };
    s.pending.arrange = s.pending.arrange.filter(x => x !== seat);
    this.evPush('arrangeDone', { seat });
    this.say(seat, '完成了摆猫');
    if (s.pending.arrange.length === 0) {
      const dirSeat = s.round === 1 ? (s.pending.direction != null ? s.pending.direction : s.players[0].seat) : null;
      if (dirSeat != null && s.round === 1) {
        s.phase = 'direction';
        this.evPush('phase', { phase: 'direction' });
        this.evPush('askDirection', { seat: dirSeat });
        this.commit();
      } else {
        this.beginPlaying();
      }
    } else {
      this.commit();
    }
    return { ok: true };
  }

  chooseDirection(seat, dir) {
    const s = this.s;
    if (s.phase !== 'direction' || s.round !== 1 || s.pending.direction !== seat) return { ok: false, error: '无法选择出牌顺序' };
    if (dir !== 1 && dir !== -1) return { ok: false, error: '方向无效' };
    s.direction = dir;
    s.pending.direction = null;
    this.evPush('direction', { dir });
    this.say(seat, dir === 1 ? '选择了顺时针顺序' : '选择了逆时针顺序');
    this.beginPlaying();
    return { ok: true };
  }

  beginPlaying() {
    const s = this.s;
    s.phase = 'playing';
    // 首个行动者为 1 号位（座位 0）本身（方向只影响下家）
    s.currentSeat = s.round === 1 ? s.players[0].seat : nextAliveSeat(s, s.eliminatedSeat, s.direction);
    this.evPush('phase', { phase: 'playing' });
    this.evPush('turn', { seat: s.currentSeat });
    this.commit();
  }

  // ---------- 辅助：猫牌 ----------
  faceDownCat(p, slotIdx) {
    const slot = p.cats[slotIdx];
    if (!slot) return null;
    if (slot.cover && !slot.coverRevealed) return slot.cover;
    if (!slot.baseRevealed) return slot.base;
    return null;
  }
  faceDownSlots(p) {
    const out = [];
    p.cats.forEach((sl, i) => { if (this.faceDownCat(p, i)) out.push(i); });
    return out;
  }
  hasRevealed(p) {
    return p.cats.some(sl => sl.baseRevealed || sl.coverRevealed);
  }
  isSilenced(p) { return p.silenceMarkers.length > 0; }

  // 摸牌（含弃牌堆重洗）
  draw(seat, n) {
    const s = this.s;
    const p = s.players[seat];
    let got = 0;
    for (let i = 0; i < n; i++) {
      if (s.deck.length === 0) {
        // 重洗弃牌堆（保留顶牌 = 当前参照牌）
        if (s.discard.length <= 1) break;
        const top = s.discard.pop();
        s.deck = shuffle(s.discard);
        s.discard = [top];
        this.evPush('reshuffle', { toDeck: s.deck.length });
      }
      const c = s.deck.pop();
      p.hand.push(c);
      got++;
    }
    if (got > 0) {
      this.evPush('draw', { seat, count: got, deckCount: s.deck.length });
      this.say(seat, `摸了 ${got} 张牌`);
    }
    return got;
  }

  // 出牌后的保护/禁言失效检查
  expireCheck(played) {
    const s = this.s;
    for (const p of s.players) {
      if (p.eliminated) continue;
      p.cats.forEach((sl, i) => {
        if (!sl.protected) return;
        const hit = played.type === 'wild' ||
          (played.type === 'number' && played.point === sl.protectTrigger);
        if (hit) {
          sl.protected = false; sl.protectTrigger = null;
          this.evPush('protectOff', { seat: p.seat, slot: i });
          this.say(p.seat, '的保护牌失效了');
        }
      });
      // 禁言失效：灰色万能牌，或同色且点数命中
      if (p.silenceMarkers.length > 0) {
        const kept = [];
        for (const mk of p.silenceMarkers) {
          const hit = played.type === 'wild' ||
            (played.color !== GRAY && played.color === mk.color && mk.triggers.includes(played.point));
          if (!hit) kept.push(mk);
        }
        if (kept.length !== p.silenceMarkers.length) {
          p.silenceMarkers = kept;
          this.evPush('muteOff', { seat: p.seat, left: kept.length });
          this.say(p.seat, kept.length === 0 ? '解除了禁言' : `减少了一个禁言标记（剩 ${kept.length}）`);
        }
      }
    }
  }

  // ---------- 行动 ----------
  actPlay(seat, cardId, targets = {}) {
    const s = this.s;
    if (!this.isMyTurn(seat)) return { ok: false, error: '不是你的回合' };
    if (s.pending.counter) return { ok: false, error: '正在等待反猜' };
    const p = s.players[seat];
    const card = p.hand.find(c => c.id === cardId);
    if (!card) return { ok: false, error: '手牌中没有这张牌' };
    if (!canPlayOn(card, s.lastCard)) return { ok: false, error: '此牌不能打在上家的牌上' };
    if (card.type === 'wild') {
      s.pending.wild = { seat, cardId };
      this.evPush('askWild', { seat, cardId });
      this.commit();
      return { ok: true };
    }
    // 互换前置检查：可互换对象不足则不允许
    if (card.func === FUNC_SWAP) {
      const pool = this.swapPool();
      if (pool.count < 2) return { ok: false, error: '场上可互换的猫牌不足两张' };
    }
    const targetsOk = this.validateTargets(seat, card, targets);
    if (!targetsOk.ok) return targetsOk;
    this.completePlay(seat, card, targets);
    return { ok: true };
  }

  validateTargets(seat, card, targets) {
    const s = this.s;
    const p = s.players[seat];
    if (card.func === FUNC_PEEK || card.func === FUNC_PROTECT) return { ok: true }; // 允许空放
    if (card.func === FUNC_MUTE) {
      const t = targets.seat;
      if (t == null) return { ok: false, error: '需要选择目标' };
      const tp = s.players[t];
      if (!tp || tp.eliminated) return { ok: false, error: '目标无效' };
      return { ok: true };
    }
    if (card.func === FUNC_SWAP) {
      const a = targets.a, b = targets.b;
      if (!a || !b) return { ok: false, error: '需要选择两张猫牌' };
      const sameKind = (a.kind === 'table') === (b.kind === 'table');
      if (!sameKind || (a.kind !== 'table' && a.kind !== 'hand')) return { ok: false, error: '互换对象类型无效' };
      if (a.kind === 'table') {
        if (a.seat === b.seat && a.slot === b.slot) return { ok: false, error: '不能互换同一张' };
        const pa = s.players[a.seat], pb = s.players[b.seat];
        const sa = pa && pa.cats[a.slot], sb = pb && pb.cats[b.slot];
        if (!pa || !pb || pa.eliminated || pb.eliminated) return { ok: false, error: '对象无效' };
        if (!sa || !sb || sa.protected || sb.protected) return { ok: false, error: '受保护的猫牌不能互换' };
        if (!this.faceDownCat(pa, a.slot) || !this.faceDownCat(pb, b.slot)) return { ok: false, error: '只能互换盖置的猫牌' };
        return { ok: true };
      }
      // 手牌猫互换
      if (!this.useHandCatRule()) return { ok: false, error: '手牌猫规则未开启' };
      if (a.seat === b.seat) return { ok: false, error: '需要两名玩家' };
      const pa = s.players[a.seat], pb = s.players[b.seat];
      if (!pa || !pb || pa.eliminated || pb.eliminated || !pa.handCat || !pb.handCat) return { ok: false, error: '对象无效' };
      return { ok: true };
    }
    return { ok: true };
  }

  // 可互换对象统计
  swapPool() {
    const s = this.s;
    let table = 0, hands = 0;
    for (const p of s.players) {
      if (p.eliminated) continue;
      table += p.cats.filter(sl => !sl.protected && this.faceDownCat(p, p.cats.indexOf(sl))).length;
      if (p.handCat) hands++;
    }
    return { table, hands, count: Math.floor(table) + (this.useHandCatRule() && hands >= 2 ? hands - 1 : 0) };
  }

  completePlay(seat, card, targets) {
    const s = this.s;
    const p = s.players[seat];
    p.hand = p.hand.filter(c => c.id !== card.id);
    s.discard.push(card);
    s.lastCard = card;
    this.evPush('play', { seat, card });
    this.say(seat, `打出 ${cardName(card)}`);
    // 失效检查（在效果之前）
    this.expireCheck(card);
    // 效果
    switch (card.func) {
      case FUNC_DRAW: {
        const n = 1 + (this.hasRevealed(p) ? 1 : 0);
        this.draw(seat, n);
        break;
      }
      case FUNC_PEEK: {
        const t = targets.seat != null ? s.players[targets.seat] : null;
        if (t && !t.eliminated && targets.kind === 'hand') {
          if (t.handCat) {
            this.evPush('peek', { by: seat, targetSeat: t.seat, kind: 'hand', cat: t.handCat });
            this.say(seat, `观看了 ${t.name} 的手牌猫牌`);
          }
        } else if (t && (t.seat === seat || neighborSeats(s, seat).includes(t.seat))) {
          const sl = t.cats[targets.slot];
          const f = sl ? this.faceDownCat(t, targets.slot) : null;
          if (f) {
            if (sl.protected) {
              this.evPush('peekBlocked', { by: seat, targetSeat: t.seat, slot: targets.slot });
              this.say(seat, '观看被保护挡住了');
            } else {
              this.evPush('peek', { by: seat, targetSeat: t.seat, kind: 'table', slot: targets.slot, cat: f });
              this.say(seat, `观看了 ${t.name} 的一张猫牌`);
            }
          }
        }
        break;
      }
      case FUNC_SWAP: {
        const a = targets.a, b = targets.b;
        if (a.kind === 'table') {
          const pa = s.players[a.seat], pb = s.players[b.seat];
          const tmp = pa.cats[a.slot];
          pa.cats[a.slot] = pb.cats[b.slot];
          pb.cats[b.slot] = tmp;
          this.evPush('swap', { kind: 'table', a: { seat: a.seat, slot: a.slot }, b: { seat: b.seat, slot: b.slot } });
          this.say(seat, `互换了 ${pa.name} 与 ${pb.name} 的猫牌`);
        } else {
          const pa = s.players[a.seat], pb = s.players[b.seat];
          const tmp = pa.handCat; pa.handCat = pb.handCat; pb.handCat = tmp;
          this.evPush('swap', { kind: 'hand', a: { seat: a.seat }, b: { seat: b.seat } });
          this.say(seat, `互换了 ${pa.name} 与 ${pb.name} 的手牌猫牌`);
        }
        break;
      }
      case FUNC_PROTECT: {
        const t = targets.seat != null ? s.players[targets.seat] : null;
        if (t && !t.eliminated) {
          const sl = t.cats[targets.slot];
          if (t.seat === seat) {
            // 保护自己的盖置猫牌
            if (sl && this.faceDownCat(t, targets.slot) && !sl.protected) {
              sl.protected = true; sl.protectTrigger = card.triggers[0];
              this.evPush('protect', { targetSeat: t.seat, slot: targets.slot, on: true, trigger: card.triggers[0] });
              this.say(seat, `保护了自己的猫牌（触发数字 ${card.triggers[0]}）`);
            } else {
              this.say(seat, '没有可保护的猫牌（保护牌空放）');
            }
          } else if (s.settings.protectOthers && sl && sl.protected) {
            // 可选规则：解除他人保护
            sl.protected = false; sl.protectTrigger = null;
            this.evPush('protect', { targetSeat: t.seat, slot: targets.slot, on: false });
            this.say(seat, `解除了 ${t.name} 的保护`);
          } else {
            this.say(seat, '保护目标无效（保护牌空放）');
          }
        } else {
          this.say(seat, '保护牌空放');
        }
        break;
      }
      case FUNC_MUTE: {
        const t = s.players[targets.seat];
        if (!t || t.eliminated) break;
        if (t.seat === seat) {
          // 用于自己：解除自己全部禁言 + 摸 1 张
          const had = t.silenceMarkers.length;
          t.silenceMarkers = [];
          this.evPush('muteSelf', { seat, had });
          this.draw(seat, 1);
          this.say(seat, had > 0 ? `解除了自己的禁言并摸了 1 张牌` : `对自己使用禁言，摸了 1 张牌`);
        } else {
          t.silenceMarkers.push({ triggers: card.triggers.slice(), color: card.color });
          this.evPush('mute', { by: seat, targetSeat: t.seat, triggers: card.triggers.slice(), color: card.color });
          this.say(seat, `禁言了 ${t.name}`);
        }
        break;
      }
    }
    this.afterAction(seat);
  }

  // 万能牌选择颜色与点数
  chooseWild(seat, color, point) {
    const s = this.s;
    if (!s.pending.wild || s.pending.wild.seat !== seat) return { ok: false, error: '无需选择' };
    if ((color !== WHITE && color !== BLACK) || !Number.isInteger(point) || point < 1 || point > 5) {
      return { ok: false, error: '选择无效' };
    }
    const p = s.players[seat];
    const card = p.hand.find(c => c.id === s.pending.wild.cardId);
    s.pending.wild = null;
    if (!card) return { ok: false, error: '万能牌不见了' };
    card.assignedColor = color;
    card.assignedPoint = point;
    this.completePlay(seat, card, {});
    return { ok: true };
  }

  // 取消万能牌待选（弹窗关闭时调用，牌留在手中）
  cancelWild(seat) {
    const s = this.s;
    if (s.pending && s.pending.wild && s.pending.wild.seat === seat) {
      s.pending.wild = null;
      this.evPush('wildCancel', { seat });
      this.commit();
      return { ok: true };
    }
    return { ok: false, error: '无需取消' };
  }

  // 翻猫跳过（翻 1 张猫牌，摸其点数张牌，然后跳过）
  actPass(seat, slotIdx) {
    const s = this.s;
    if (!this.isMyTurn(seat)) return { ok: false, error: '不是你的回合' };
    if (s.pending.counter) return { ok: false, error: '正在等待反猜' };
    const p = s.players[seat];
    const slot = p.cats[slotIdx];
    if (!slot) return { ok: false, error: '猫牌位置无效' };
    const f = this.faceDownCat(p, slotIdx);
    if (!f) return { ok: false, error: '该猫牌已翻开' };
    if (slot.cover && !slot.coverRevealed) slot.coverRevealed = true;
    else slot.baseRevealed = true;
    this.evPush('reveal', { seat, slot: slotIdx, cat: f, covered: !!slot.cover && slot.coverRevealed });
    this.say(seat, `翻开了自己的猫牌 —— ${catName(f)}`);
    this.draw(seat, f.point);
    if (this.faceDownSlots(p).length === 0) {
      this.eliminate(seat, 'cats');
    } else {
      this.afterAction(seat);
    }
    return { ok: true };
  }

  // 额外猫牌规则：盖猫续命（下家摸 2，手牌猫盖到已翻开的猫位上）
  actCover(seat, slotIdx) {
    const s = this.s;
    if (!this.isMyTurn(seat)) return { ok: false, error: '不是你的回合' };
    if (s.pending.counter) return { ok: false, error: '正在等待反猜' };
    if (!this.useHandCatRule()) return { ok: false, error: '规则未开启' };
    const p = s.players[seat];
    if (!p.handCat) return { ok: false, error: '你手里没有猫牌' };
    if (s.turnCoverUsed) return { ok: false, error: '本回合已经盖过一次' };
    const slot = p.cats[slotIdx];
    if (!slot || !slot.baseRevealed || slot.cover) return { ok: false, error: '只能盖到翻开且未盖过的猫位上' };
    const cat = p.handCat;
    p.handCat = null;
    slot.cover = cat; slot.coverRevealed = false;
    const next = nextAliveSeat(s, seat, s.direction);
    this.evPush('cover', { seat, slot: slotIdx, toSeat: next });
    this.say(seat, `用猫牌盖住了翻开的猫位，${seatName(s, next)} 摸了 2 张牌`);
    this.draw(next, 2);
    s.turnCoverUsed = true;
    this.commit();
    return { ok: true };
  }

  // ---------- 猜牌 ----------
  actGuess(seat, targetSeat, colors, discardIds) {
    const s = this.s;
    if (!this.isMyTurn(seat)) return { ok: false, error: '不是你的回合' };
    if (s.pending.counter) return { ok: false, error: '正在等待反猜' };
    const p = s.players[seat];
    if (this.isSilenced(p)) return { ok: false, error: '你被禁言了，不能猜牌' };
    const t = s.players[targetSeat];
    if (!t || t.seat === seat || t.eliminated) return { ok: false, error: '目标无效' };
    if (!Array.isArray(discardIds) || discardIds.length === 0) return { ok: false, error: '请选择弃置的点数牌' };
    const cards = discardIds.map(id => p.hand.find(c => c.id === id)).filter(Boolean);
    if (cards.length !== discardIds.length) return { ok: false, error: '弃置的牌无效' };
    let sum = 0;
    for (const c of cards) {
      if (c.type !== 'number') return { ok: false, error: '只能弃置点数牌' };
      sum += c.point;
    }
    if (sum !== 5) return { ok: false, error: `点数总和必须严格为 5（当前 ${sum}）` };
    const fdIdx = this.faceDownSlots(t);
    if (fdIdx.length === 0) return { ok: false, error: '对方没有未翻开的猫牌' };
    if (!Array.isArray(colors) || colors.length !== fdIdx.length) return { ok: false, error: `需要报出 ${fdIdx.length} 个颜色` };
    for (const c of colors) if (c !== WHITE && c !== BLACK) return { ok: false, error: '颜色无效' };
    // 弃置
    p.hand = p.hand.filter(c => !cards.includes(c));
    s.discard.push(...cards);
    this.evPush('guessDiscard', { seat, cards });
    this.say(seat, `弃置 ${cards.map(c => cardName(c)).join('、')}，猜测 ${t.name} 的猫牌`);
    // 比对（按座位顺序，仅对未翻开位）
    let allOk = true;
    fdIdx.forEach((slotIdx, i) => {
      const f = this.faceDownCat(t, slotIdx);
      if (f.color !== colors[i]) allOk = false;
    });
    this.evPush('guess', { guessSeat: seat, targetSeat, colors, ok: allOk });
    if (allOk) {
      this.say(seat, `猜中了！${t.name} 被淘汰`);
      this.eliminate(t.seat, 'guess', seat, { guessRewardSeat: seat });
    } else {
      this.say(seat, `猜错了……`);
      s.pending.counter = { guessSeat: seat, targetSeat: t.seat };
      this.evPush('askCounter', { toSeat: t.seat, guessSeat: seat });
      this.commit();
    }
    return { ok: true };
  }

  // 反猜：decline 或 { colors[], discardCardId }
  actCounter(seat, payload) {
    const s = this.s;
    const c = s.pending.counter;
    if (!c || c.targetSeat !== seat) return { ok: false, error: '没有等待你的决定' };
    const guesser = s.players[c.guessSeat];
    const target = s.players[c.targetSeat];
    if (payload && payload.decline !== true) {
      // 被猜方弃 1 张牌进行反猜（被禁言者不可反猜）
      if (this.isSilenced(target)) {
        s.pending.counter = null;
        this.say(seat, '被禁言，无法反猜');
        this.evPush('counter', { guessSeat: c.guessSeat, targetSeat: seat, declined: true, muted: true });
      } else {
        const card = target.hand.find(x => x.id === payload.discardCardId);
        const fdIdx = this.faceDownSlots(guesser);
        const colors = payload.colors;
        const validCard = card && colors && colors.length === fdIdx.length &&
          colors.every(col => col === WHITE || col === BLACK);
        if (!validCard) return { ok: false, error: '反猜数据无效' };
        s.pending.counter = null;
        target.hand = target.hand.filter(x => x.id !== card.id);
        s.discard.push(card);
        let allOk = true;
        fdIdx.forEach((slotIdx, i) => {
          const f = this.faceDownCat(guesser, slotIdx);
          if (f.color !== colors[i]) allOk = false;
        });
        this.evPush('counter', { guessSeat: c.guessSeat, targetSeat: seat, colors, ok: allOk, discard: card });
        this.say(seat, `弃 1 张牌进行反猜 ——${allOk ? '猜中！' : '猜错'}`);
        if (allOk) {
          this.say(seat, `反猜成功！${guesser.name} 被淘汰`);
          this.eliminate(guesser.seat, 'counter', seat);
        } else {
          this.say(guesser.seat, `反猜失败，${guesser.name} 被淘汰`);
          this.eliminate(guesser.seat, 'guessfail');
        }
        return { ok: true };
      }
    } else {
      s.pending.counter = null;
      this.evPush('counter', { guessSeat: c.guessSeat, targetSeat: seat, declined: true });
      this.say(seat, '放弃反猜');
    }
    this.say(guesser.seat, `${guesser.name} 被淘汰`);
    this.eliminate(guesser.seat, 'guessfail');
    return { ok: true };
  }

  // ---------- 淘汰与奖励 ----------
  eliminate(seat, reason, bySeat = null, opts = {}) {
    const s = this.s;
    const p = s.players[seat];
    if (!p || p.eliminated) return;
    p.eliminated = true;
    s.eliminatedSeat = seat;
    this.evPush('eliminate', { seat, reason, by: bySeat });
    this.say(seat, '被淘汰！');
    if (bySeat != null && (reason === 'guess' || reason === 'counter')) {
      s.players[bySeat].wonByGuessLastRound = true;
    }
    const alive = livingPlayers(s);
    if (alive.length <= 1) {
      this.finishMatch(alive[0] && alive[0].seat);
      return;
    }
    // 猜牌奖励：猜方摸至 5 张（先于淘汰奖励）
    if (opts.guessRewardSeat != null) {
      const gp = s.players[opts.guessRewardSeat];
      if (gp && !gp.eliminated) {
        const need = 5 - gp.hand.length;
        if (need > 0) {
          this.draw(gp.seat, need);
          this.say(gp.seat, '猜牌奖励：手牌补至 5 张');
        }
      }
    }
    // 玩家淘汰奖励：所有剩余玩家（未被禁言）摸 1 张
    for (const q of alive) {
      if (!this.isSilenced(q)) this.draw(q.seat, 1);
    }
    if (this.s.settings.eliminationMode) {
      // 淘汰制玩法：立刻重开一局
      this.evPush('phase', { phase: 'arrange' });
      this.commit();
      this.startRound();
    } else {
      this.afterAction(opts.fromSeat != null ? opts.fromSeat : seat);
    }
  }

  finishMatch(winnerSeat) {
    const s = this.s;
    s.phase = 'matchover';
    s.winnerSeat = winnerSeat;
    const w = s.players[winnerSeat];
    this.evPush('phase', { phase: 'matchover' });
    this.evPush('gameover', { winnerSeat, name: w ? w.name : '?' });
    this.say(winnerSeat, '获得了最终胜利！');
    this.commit();
  }

  // 回合结束切换
  afterAction(fromSeat) {
    const s = this.s;
    if (s.phase !== 'playing') return;
    const next = nextAliveSeat(s, fromSeat, s.direction);
    if (next === -1) return;
    s.currentSeat = next;
    s.turnCoverUsed = false;
    this.evPush('turn', { seat: next });
    this.commit();
  }

  isMyTurn(seat) {
    const s = this.s;
    return s.phase === 'playing' && !s.pending.wild &&
      s.currentSeat === seat && !s.players[seat].eliminated;
  }

  // ---------- 重赛 / 回大厅 ----------
  rematch() {
    const s = this.s;
    if (s.phase !== 'matchover') return { ok: false, error: '对局未结束' };
    s.players.forEach(p => { p.eliminated = false; p.wonByGuessLastRound = false; });
    s.direction = 1;
    s.round = 0;
    this.startRound();
    return { ok: true };
  }

  backToLobby() {
    const s = this.s;
    if (s.phase !== 'matchover') return { ok: false, error: '对局未结束' };
    s.phase = 'lobby';
    s.winnerSeat = -1;
    s.players.forEach(p => { p.eliminated = false; p.ready = false; p.wonByGuessLastRound = false; });
    this.evPush('phase', { phase: 'lobby' });
    this.commit();
    return { ok: true };
  }

  setReady(seat, ready) {
    const s = this.s;
    if (s.phase !== 'lobby') return { ok: false, error: '不在大厅' };
    if (s.players[seat]) s.players[seat].ready = ready;
    this.evPush('ready', { seat, ready });
    this.commit();
    return { ok: true };
  }

  setSettings(seat, settings) {
    const s = this.s;
    if (seat !== s.hostSeat || s.phase !== 'lobby') return { ok: false, error: '只有房主可在大厅修改规则' };
    for (const k of ['extraCats2or3', 'handCatRule', 'protectOthers', 'eliminationMode']) {
      if (typeof settings[k] === 'boolean') s.settings[k] = settings[k];
    }
    this.evPush('settings', { settings: { ...s.settings } });
    this.commit();
    return { ok: true };
  }

  commit() {
    this.s.v += 1;
    this.s.events = this.ev;
    this.s.log = this.log.slice(-120);
    this.ev = [];
  }
}