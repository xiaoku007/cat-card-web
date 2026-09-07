// gameui.js —— 游戏桌面 UI 与动效（杀戮尖塔风格：平滑位移动画、翻牌、飞牌）
'use strict';

import { cardName, cardTitle, catName, canPlayOn, WHITE, BLACK, FUNC_DRAW, FUNC_PEEK, FUNC_SWAP, FUNC_PROTECT, FUNC_MUTE } from './cards.js';
import { neighborSeats } from './util.js';

const $ = (id) => document.getElementById(id);

export class GameUI {
  constructor(hooks) {
    // hooks: { act(type, payload), err(msg), isHost(), mySeat(), toast(msg) }
    this.hooks = hooks;
    this.s = null;
    this.mySeat = -1;
    this.prevHand = new Map();   // cardId -> rect (上次渲染)
    this.animQueue = [];
    this.animBusy = false;
    this.handSel = new Set();    // 当前选中的手牌（猜牌用）
    this.renderSeq = 0;
  }

  // ---------- 入口 ----------
  render(state) {
    if (!state) return;
    const seq = ++this.renderSeq;
    this.s = JSON.parse(JSON.stringify(state));
    this.mySeat = this.hooks.mySeat();
    const evs = state.events || [];
    this.buildStatic(seq);
    this.renderOpponents();
    this.renderCenter();
    this.renderMyArea();
    this.renderLog(state);
    this.queryableFlush(seq, evs);
  }

  // 结构骨架（座位布局变化时重建）
  buildStatic(seq) {
    const opp = $('opponents');
    const n = this.s.players.length;
    if (opp.dataset.n !== String(n)) {
      opp.dataset.n = String(n);
      opp.innerHTML = '';
      for (let i = 0; i < n - 1; i++) {
        const z = document.createElement('div');
        z.className = 'player-zone opz';
        z.dataset.slot = i;
        opp.appendChild(z);
      }
      opp.classList.toggle('two', n === 2);
    }
  }

  otherSeats() {
    return this.s.players
      .filter(p => p.seat !== this.mySeat)
      .sort((a, b) => a.seat - b.seat);
  }

  zoneFor(seat) {
    const others = this.otherSeats();
    const idx = others.findIndex(p => p.seat === seat);
    if (idx < 0) return null;
    const z = document.querySelector(`.opz[data-slot="${idx}"]`);
    return z;
  }

  // ---------- 对手区域 ----------
  renderOpponents() {
    const s = this.s;
    if (s.phase === 'lobby') return;
    for (const p of this.otherSeats()) {
      const z = this.zoneFor(p.seat);
      if (!z) continue;
      z.innerHTML = '';
      z.classList.toggle('active', s.currentSeat === p.seat && s.phase === 'playing');
      z.classList.toggle('dead', p.eliminated);
      z.classList.toggle('offline', !p.connected);

      const bar = document.createElement('div');
      bar.className = 'oz-bar';
      const muting = p.silenceMarkers.length > 0;
      bar.innerHTML = `
        <span class="oz-name">${escapeHtml(p.name)}</span>
        ${muting ? `<span class="badge-mute">禁言×${p.silenceMarkers.length}</span>` : ''}
        ${!p.connected ? '<span class="badge-dc">断线</span>' : ''}
      `;
      z.appendChild(bar);

      // 手牌堆（只显示数量）
      const hp = document.createElement('div');
      hp.className = 'oz-hand';
      if (p.hand.length > 0) {
        for (let i = 0; i < Math.min(6, p.hand.length); i++) {
          const c = document.createElement('div');
          c.className = 'card card-mini back';
          c.innerHTML = backHTML();
          c.style.marginLeft = i === 0 ? '0' : '-26px';
          hp.appendChild(c);
        }
      }
      const cnt = document.createElement('span');
      cnt.className = 'oz-count';
      cnt.textContent = `${p.hand.length} 张`;
      hp.appendChild(cnt);
      // 手牌猫标记
      if (p.handCat) {
        const hc = document.createElement('span');
        hc.className = 'oz-handcat';
        hc.textContent = '📦手牌猫';
        hp.appendChild(hc);
      }
      z.appendChild(hp);

      // 猫牌
      const cats = document.createElement('div');
      cats.className = 'oz-cats';
      p.cats.forEach((sl, i) => {
        cats.appendChild(this.catSlotEl(p, sl, i, true));
      });
      z.appendChild(cats);

      const tag = document.createElement('div');
      tag.className = 'oz-tag';
      tag.textContent = p.eliminated ? '淘汰' : '猫牌';
      z.appendChild(tag);
    }
  }

  // 猫牌单元 DOM（敌我共用）
  catSlotEl(p, sl, i, isOpp) {
    const el = document.createElement('div');
    el.className = 'catslot' + (sl.protected ? ' protected' : '');
    const fd = sl.cover && !sl.coverRevealed ? sl.cover : (!sl.baseRevealed ? sl.base : null);
    let showCat = null;
    if (!fd) {
      if (sl.cover && sl.coverRevealed) showCat = sl.cover;
      else if (sl.baseRevealed) showCat = sl.base;
    }
    // 摆猫阶段：本人可预览自己盖置猫牌的内容，方便安排顺序
    const preview = !isOpp && p.seat === this.mySeat && this.s.phase === 'arrange' && !!fd;
    if (fd) {
      el.classList.add('facedown');
      if (preview) {
        el.classList.add('previewing');
        el.title = '摆猫预览：' + catName(fd) + '（开局后翻回盖置）';
        el.innerHTML = catFaceHTML(fd);
        const badge = document.createElement('span');
        badge.className = 'preview-badge';
        badge.textContent = '👁 预览';
        el.appendChild(badge);
      } else {
        el.innerHTML = catBackHTML();
      }
    } else if (showCat) {
      el.classList.add('revealed');
      el.innerHTML = catFaceHTML(showCat);
    }
    if (sl.cover) el.classList.add('covered');
    // 主人视角：自己盖的猫牌知道身份
    if (!isOpp && p.seat === this.mySeat && sl.cover && !sl.coverRevealed) {
      el.title = '你盖的猫牌：' + catName(sl.cover);
      const cue = document.createElement('span');
      cue.className = 'cover-cue';
      cue.textContent = catName(sl.cover);
      el.appendChild(cue);
    }
    if (sl.protected) {
      const sh = document.createElement('span');
      sh.className = 'shield';
      sh.title = `保护中（打出 ${sl.protectTrigger} 点数牌或万能牌解除）`;
      sh.textContent = '🛡' + sl.protectTrigger;
      el.appendChild(sh);
    }
    el.dataset.catSeat = p.seat;
    el.dataset.catIdx = i;
    return el;
  }

  // ---------- 中央区域 ----------
  renderCenter() {
    const s = this.s;
    if (s.phase === 'lobby') return;
    $('deck-count').textContent = s.deck ? s.deck.length : 0;
    const back = document.querySelector('#draw-pile .pile-back');
    if (back && !back.querySelector('img')) back.innerHTML = backHTML();
    const discard = $('discard-pile');
    const last = s.lastCard;
    if (last) {
      discard.innerHTML = '';
      const el = document.createElement('div');
      el.className = 'card card-face last-card ' + colorClass(last);
      el.title = cardTitle(last);
      el.innerHTML = cardFaceHTML(last);
      discard.appendChild(el);
    } else {
      discard.innerHTML = '';
    }
    const db = $('direction-badge');
    db.classList.remove('hidden');
    db.textContent = s.direction === 1 ? '↻ 顺' : '↺ 逆';
    const rn = $('round-info');
    if (!rn) {
      const r = document.createElement('div');
      r.id = 'round-info';
      r.className = 'round-info';
      $('board-center').appendChild(r);
    }
    $('round-info').textContent = s.settings.eliminationMode ? `淘汰制 · 第${s.round}局` : `第${s.round}局`;
  }

  // ---------- 我的区域 ----------
  renderMyArea() {
    const s = this.s;
    const me = s.players[this.mySeat];
    const area = $('my-area');
    if (s.phase === 'lobby' || !me) { area.innerHTML = ''; return; }

    // 我的猫牌
    const catsRow = $('my-cats');
    if (!catsRow) { area.innerHTML = '<div id="my-cats" class="my-cats"></div><div id="my-info" class="my-info"></div><div id="hand" class="hand"></div><div id="actions" class="actions"></div>'; }
    const cw = $('my-cats');
    cw.innerHTML = '';
    me.cats.forEach((sl, i) => {
      const el = this.catSlotEl(me, sl, i, false);
      if (s.phase === 'arrange' && s.pending.arrange.includes(this.mySeat)) {
        el.classList.add('arrangeable');
        el.onclick = () => this.onArrangeClick(i);
        if (this.handSel.has('arr-' + i)) el.classList.add('sel');
      } else if (s.phase === 'playing' && this.isMyTurn()) {
        el.onclick = () => this.tryPass(i);
        el.classList.add('clickable');
      }
      cw.appendChild(el);
    });

    // 信息栏
    const info = $('my-info');
    const muting = me.silenceMarkers.length > 0;
    info.innerHTML = `
      <span class="mi-name">${escapeHtml(me.name)}${s.hostSeat === me.seat ? ' 👑' : ''}</span>
      ${muting ? `<span class="badge-mute">禁言×${me.silenceMarkers.length}</span>` : ''}
      ${me.handCat ? '<span class="oz-handcat">📦手牌猫</span>' : ''}
      ${me.eliminated ? '<span class="badge-dc">已淘汰</span>' : ''}
    `;

    // 手牌
    this.renderHand(me);

    // 按钮
    this.renderActions(me);
  }

  renderHand(me) {
    const s = this.s;
    const handEl = $('hand');
    const prevRects = new Map();
    for (const el of handEl.querySelectorAll('.hcard')) prevRects.set(el.dataset.id, el.getBoundingClientRect());
    this.prevHandRectMap = prevRects;
    // 记录上次存在的手牌 id
    const prevIds = this.prevHandIds || new Set();
    const curIds = new Set(me.hand.map(c => c.id));

    handEl.innerHTML = '';
    const n = me.hand.length;
    const W = handEl.clientWidth || Math.min(window.innerWidth - 120, 1500);
    const cardW = 108;
    const maxOff = Math.max(1, (n - 1) / 2);
    // 横向密度自适应：总宽不超出容器；牌越多叠得越密
    const step = n > 1 ? Math.min(86, (W - cardW) / (n - 1)) : 0;
    const startX = Math.max(0, (W - (cardW + step * (n - 1))) / 2);
    // 弧度随牌数收敛：最大下沉 ≤48px、最大旋转 ≤11deg，避免牌飞出可视范围
    const yK = Math.min(6.5, 48 / (maxOff * maxOff));
    const rotK = Math.min(2.0, 11 / maxOff);

    me.hand.forEach((c, i) => {
      const el = document.createElement('div');
      el.className = 'card card-face hcard ' + colorClass(c) + (this.isPlayable(c) ? ' playable' : '');
      if (this.handSel.has(c.id)) el.classList.add('sel');
      el.dataset.id = c.id;
      el.title = cardTitle(c);
      el.innerHTML = cardFaceHTML(c);
      const off = i - (n - 1) / 2;
      const x = startX + i * step;
      const y = Math.abs(off) * Math.abs(off) * yK;
      const rot = off * rotK;
      el.style.left = x + 'px';
      el.style.transform = `translateY(${y}px) rotate(${rot}deg)`;
      el.style.zIndex = String(i + 1);
      el.onclick = () => this.onHandClick(c, el);
      handEl.appendChild(el);
    });

    // FLIP：从旧位置平滑移动到新位置
    requestAnimationFrame(() => {
      const newEls = handEl.querySelectorAll('.hcard');
      const deckRect = $('draw-pile').getBoundingClientRect();
      newEls.forEach((el, i) => {
        const id = el.dataset.id;
        const oldR = prevRects.get(id);
        if (!oldR) {
          // 新入手（摸牌）：从牌堆飞入
          if (!prevIds.has(id)) {
            const r = el.getBoundingClientRect();
            el.animate(
              [{ transform: `translate(${deckRect.left - r.left + deckRect.width / 2}px, ${deckRect.top - r.top}px) rotate(-14deg) scale(.6)`, opacity: 0 },
               { transform: getComputedStyle(el).transform, opacity: 1 }],
              { duration: 320 + Math.min(i * 40, 300), easing: 'cubic-bezier(.2,.8,.3,1)' }
            );
          }
        } else if (Math.abs(oldR.left - el.getBoundingClientRect().left) > 2) {
          const r = el.getBoundingClientRect();
          el.animate(
            [{ transform: `translate(${oldR.left - r.left}px, ${oldR.top - r.top}px)` },
             { transform: getComputedStyle(el).transform }],
            { duration: 220, easing: 'cubic-bezier(.2,.8,.3,1)' }
          );
        }
      });
    });
    this.prevHandIds = curIds;
  }

  isPlayable(c) {
    const s = this.s;
    if (!s.lastCard) return true;
    if (c.type === 'wild') return true;
    if (c.func === FUNC_SWAP) {
      // 可互换不足两张时不可打出
      return this.swapCount() >= 2;
    }
    return canPlayOn(c, s.lastCard);
  }

  swapCount() {
    const s = this.s;
    let table = 0, hands = 0;
    for (const p of s.players) {
      if (p.eliminated) continue;
      for (const sl of p.cats) {
        if (!sl.protected && ((sl.cover && !sl.coverRevealed) || !sl.baseRevealed)) table++;
      }
      if (p.handCat) hands++;
    }
    const handPairs = s.settings.handCatRule && s.players.filter(p => !p.eliminated).length <= 3 && hands >= 2 ? 1 : 0;
    return Math.floor(table / 2) + handPairs;
  }

  isMyTurn() {
    const s = this.s;
    return s.phase === 'playing' && !s.pending.wild &&
      s.currentSeat === this.mySeat && !s.players[this.mySeat].eliminated;
  }

  renderActions(me) {
    const s = this.s;
    const box = $('actions');
    box.innerHTML = '';
    // 摆猫阶段
    if (s.phase === 'arrange' && s.pending.arrange.includes(this.mySeat)) {
      box.innerHTML = `<div class="action-bar arrange-bar">
        <span>点击两张猫牌交换位置</span>
        <button class="btn primary" id="btn-arr-done">确认摆猫 ✓</button>
      </div>`;
      $('btn-arr-done').onclick = () => this.hooks.act('arrangeDone', {});
      return;
    }
    if (s.phase === 'direction' && s.round === 1 && s.pending.direction === this.mySeat) {
      box.innerHTML = `<div class="action-bar"><span>选择出牌顺序：</span>
        <button class="btn primary" id="btn-dir-cw">顺时针 ↻</button>
        <button class="btn" id="btn-dir-ccw">逆时针 ↺</button></div>`;
      $('btn-dir-cw').onclick = () => this.hooks.act('direction', { dir: 1 });
      $('btn-dir-ccw').onclick = () => this.hooks.act('direction', { dir: -1 });
      return;
    }
    if (s.phase === 'matchover') {
      const w = s.players[s.winnerSeat];
      box.innerHTML = `<div class="action-bar">
        <span class="winner-text">🏆 ${escapeHtml(w ? w.name : '?')} 胜利！</span>
        ${this.hooks.isHost() ? `
          <button class="btn primary" id="btn-rematch">再来一局</button>
          <button class="btn" id="btn-backlobby">返回大厅</button>` : '<span class="wait-text">等待房主…</span>'}
      </div>`;
      const rm = $('btn-rematch'); if (rm) rm.onclick = () => this.hooks.act('rematch', {});
      const bl = $('btn-backlobby'); if (bl) bl.onclick = () => this.hooks.act('backLobby', {});
      return;
    }
    if (s.phase !== 'playing' || me.eliminated) {
      box.innerHTML = `<div class="action-bar wait-text">${me.eliminated ? '你已被淘汰' : '等待开始…'}</div>`;
      return;
    }
    // 正常行动阶段
    const myTurn = this.isMyTurn();
    const counterWait = s.pending.counter;
    if (counterWait) {
      box.innerHTML = `<div class="action-bar wait-text">${counterWait.targetSeat === this.mySeat ? '决定反猜中…（见弹窗）' : '有人正在猜牌，等待反猜…'}</div>`;
      return;
    }
    const silenced = me.silenceMarkers.length > 0;
    let html = `<div class="action-bar">
      <span class="turn-hint ${myTurn ? 'my-turn' : ''}">${myTurn ? '▶ 轮到你' : `等待 ${escapeHtml(s.players[s.currentSeat] ? s.players[s.currentSeat].name : '…')}…`}</span>`;
    if (myTurn) {
      html += `<button class="btn" id="btn-guess" ${silenced ? 'disabled title="被禁言，不能猜牌"' : ''}>🔍 猜牌</button>`;
      const canCover = me.handCat && !s.turnCoverUsed && me.cats.some(sl => sl.baseRevealed && !sl.cover);
      if (me.handCat) html += `<button class="btn" id="btn-cover" ${canCover ? '' : 'disabled'}>📦 盖猫</button>`;
      html += `<button class="btn warn" id="btn-pass">🙀 翻猫跳过</button>`;
    }
    html += '</div>';
    box.innerHTML = html;
    const g = $('btn-guess');
    if (g) g.onclick = () => this.openGuessBuilder();
    const cv = $('btn-cover');
    if (cv) cv.onclick = () => this.openCoverPicker(me);
    const ps = $('btn-pass');
    if (ps) ps.onclick = () => {
      const fds = me.cats.map((sl, i) => (sl.cover && !sl.coverRevealed) || !sl.baseRevealed ? i : -1).filter(i => i >= 0);
      if (fds.length === 1) this.tryPass(fds[0]);
      else this.hooks.toast('点击任意一张未翻开的猫牌跳过');
    };
  }

  // ---------- 手牌点击 ----------
  onHandClick(card, el) {
    const s = this.s;
    if (s.phase === 'arrange') return;
    // 猜牌弹窗选中态由弹窗管理
    if (el.classList.contains('sel')) { this.handSel.delete(card.id); el.classList.remove('sel'); this.onGuessSelectChange(); return; }
    // 万能牌 → 选颜色
    if (card.type === 'wild') {
      if (!this.isMyTurn()) { this.hooks.err('不是你的回合'); return; }
      this.openWildModal(card);
      return;
    }
    // 需要目标的牌 → 目标选择
    if (card.func === FUNC_PEEK) { this.openPeekModal(card); return; }
    if (card.func === FUNC_SWAP) { this.openSwapModal(card); return; }
    if (card.func === FUNC_PROTECT) { this.openProtectModal(card); return; }
    if (card.func === FUNC_MUTE) { this.openMuteModal(card); return; }
    // 普通牌直接打出
    if (!this.isMyTurn()) { this.hooks.err('不是你的回合'); return; }
    if (!this.isPlayable(card)) { this.hooks.err('这张牌不能打在上家的牌上'); return; }
    this.hooks.act('play', { cardId: card.id, targets: {} });
  }

  tryPass(slotIdx) {
    const s = this.s;
    const me = s.players[this.mySeat];
    if (!this.isMyTurn()) { this.hooks.err('不是你的回合'); return; }
    const sl = me.cats[slotIdx];
    const fd = (sl.cover && !sl.coverRevealed) || !sl.baseRevealed;
    if (!fd) { this.hooks.err('该猫牌已翻开'); return; }
    this.hooks.act('pass', { slot: slotIdx });
  }

  // 摆猫交换：点击两张猫牌 → 发送增量交换（服务端交换“当前”位置的 a、b，连点天然正确）
  onArrangeClick(i) {
    if (this.handSel.has('arr-' + i)) {
      this.handSel.delete('arr-' + i);
    } else if (this.handSel.size > 0) {
      const a = parseInt([...this.handSel][0].split('-')[1], 10);
      this.handSel.clear();
      if (a !== i) this.hooks.act('arrange', { a, b: i });
    } else {
      this.handSel.add('arr-' + i);
    }
    this.refreshCatSelection();
  }

  refreshCatSelection() {
    const s = this.s;
    if (!s || s.phase !== 'arrange') return;
    document.querySelectorAll('#my-cats .catslot').forEach(el => {
      el.classList.toggle('sel', this.handSel.has('arr-' + el.dataset.catIdx));
    });
  }

  // ---------- 日志 ----------
  renderLog(state) {
    const box = $('log-lines');
    const lines = state.log || [];
    // 只在行数变化时补渲染（追加）
    if (box.children.length > lines.length) box.innerHTML = '';
    for (let i = box.children.length; i < lines.length; i++) {
      const d = document.createElement('div');
      d.className = 'log-line';
      d.textContent = lines[i];
      box.appendChild(d);
    }
    box.scrollTop = box.scrollHeight;
  }

  // ---------- 弹窗通用 ----------
  openModal(html, opts = {}) {
    const root = $('modal-root');
    root.classList.remove('hidden');
    root.innerHTML = `<div class="modal-mask"><div class="modal ${opts.wide ? 'wide' : ''}">${html}</div></div>`;
    const mask = root.querySelector('.modal-mask');
    if (opts.closable !== false) {
      mask.onclick = (e) => { if (e.target === mask) this.closeModal(); };
    }
    return root.querySelector('.modal');
  }

  closeModal() {
    const root = $('modal-root');
    root.classList.add('hidden');
    root.innerHTML = '';
  }

  // ---------- 万能牌 ----------
  openWildModal(card) {
    const m = this.openModal(`
      <h3>🎨 万能牌</h3>
      <img class="wild-preview" src="assets/cards/wild.png" alt="万能牌">
      <p>自定义颜色与点数</p>
      <div class="wild-picker">
        <div class="wp-colors">
          <button class="wp-btn color-white" data-c="white">白</button>
          <button class="wp-btn color-black" data-c="black">黑</button>
        </div>
        <div class="wp-points" id="wp-points">
          ${[1, 2, 3, 4, 5].map(p => `<button class="wp-btn" data-p="${p}">${p}</button>`).join('')}
        </div>
      </div>
      <p class="wp-preview" id="wp-preview">请选择颜色与点数</p>
    `, { closable: false });
    let color = null, point = null;
    const preview = m.querySelector('#wp-preview');
    const upd = () => {
      preview.textContent = color && point ? `打出 ${color === 'white' ? '白' : '黑'}${point}` : (color ? '选择点数' : '请选择颜色与点数');
      if (color && point) this.hooks.act('wild', { color, point });
    };
    m.querySelectorAll('[data-c]').forEach(b => b.onclick = () => { color = b.dataset.c; upd(); });
    m.querySelectorAll('[data-p]').forEach(b => b.onclick = () => { point = parseInt(b.dataset.p, 10); upd(); });
  }

  // ---------- 观看 ----------
  openPeekModal(card) {
    const s = this.s;
    const me = s.players[this.mySeat];
    const nb = neighborSeats(s, this.mySeat);
    const targets = [];
    // 自己 + 邻家
    for (const seat of [this.mySeat, ...nb]) {
      const p = s.players[seat];
      if (!p || p.eliminated) continue;
      const pkg = { seat, name: p.name, options: [] };
      p.cats.forEach((sl, i) => {
        const fd = (sl.cover && !sl.coverRevealed) || !sl.baseRevealed;
        if (fd && !sl.protected) pkg.options.push({ label: `猫牌 ${i + 1}`, val: { seat, slot: i, kind: 'table' } });
        if (fd && sl.protected) pkg.options.push({ label: `猫牌 ${i + 1}（保护中，无法观看）`, val: null });
      });
      if (p.handCat) pkg.options.push({ label: '📦 手牌猫', val: { seat, kind: 'hand' } });
      targets.push(pkg);
    }
    if (targets.every(t => t.options.length === 0 || t.options.every(o => !o.val))) {
      this.hooks.err('没有可观看的目标（邻家或自己）');
      return;
    }
    const m = this.openModal(`
      <h3>👁 观看猫牌</h3>
      <p>选择邻家或自己的一张盖置猫牌（或手牌猫）</p>
      <div class="target-groups" id="peek-groups"></div>
      <button class="btn" id="peek-cancel">取消</button>
    `);
    const gbuf = m.querySelector('#peek-groups');
    for (const t of targets) {
      const gp = document.createElement('div');
      gp.className = 'target-group';
      gp.innerHTML = `<div class="tg-title">${escapeHtml(t.name)}</div>`;
      const row = document.createElement('div');
      row.className = 'tg-row';
      for (const o of t.options) {
        const b = document.createElement('button');
        b.className = 'btn small' + (o.val ? '' : ' disabled');
        b.textContent = o.label;
        b.onclick = () => {
          if (!o.val) { this.hooks.err('受保护，无法观看'); return; }
          this.closeModal();
          this.hooks.act('play', { cardId: card.id, targets: { seat: o.val.seat, slot: o.val.slot, kind: o.val.kind } });
        };
        row.appendChild(b);
      }
      gp.appendChild(row);
      gbuf.appendChild(gp);
    }
    m.querySelector('#peek-cancel').onclick = () => this.closeModal();
  }

  // ---------- 互换 ----------
  openSwapModal(card) {
    const s = this.s;
    const m = this.openModal(`
      <h3>⇄ 互换猫牌</h3>
      <p>选择两张<b>盖置且未保护</b>的桌面猫牌，或两张手牌猫</p>
      <div class="swap-tabs">
        <button class="btn small" id="tab-table">桌面猫牌</button>
        <button class="btn small" id="tab-hand">手牌猫牌</button>
      </div>
      <div id="swap-body"></div>
      <button class="btn" id="swap-cancel">取消</button>
    `, { wide: true });
    const body = m.querySelector('#swap-body');
    const sel = [];
    const vs = {};

    const drawTable = () => {
      body.innerHTML = '<div class="tg-row wrap" id="swap-opts"></div>';
      const box = body.querySelector('#swap-opts');
      for (const p of s.players) {
        if (p.eliminated) continue;
        p.cats.forEach((sl, i) => {
          const fd = (sl.cover && !sl.coverRevealed) || !sl.baseRevealed;
          if (!fd || sl.protected) return;
          const b = document.createElement('button');
          b.className = 'btn small cat-opt';
          b.textContent = `${p.name} 猫${i + 1}`;
          b.onclick = () => {
            if (sel.length === 2) return;
            sel.push({ kind: 'table', seat: p.seat, slot: i });
            b.classList.add('sel');
            if (sel.length === 2) this.sendSwap(card, sel[0], sel[1]);
          };
          box.appendChild(b);
        });
      }
      if (body.querySelectorAll('.cat-opt').length === 0) body.innerHTML = '<p class="wait-text">没有可互换的桌面猫牌</p>';
    };
    const drawHand = () => {
      body.innerHTML = '<div class="tg-row wrap" id="swap-opts"></div>';
      const box = body.querySelector('#swap-opts');
      const holders = s.players.filter(p => !p.eliminated && p.handCat);
      if (holders.length < 2) { body.innerHTML = '<p class="wait-text">手牌猫不足两张（需 2/3 人局）</p>'; return; }
      for (const p of holders) {
        const b = document.createElement('button');
        b.className = 'btn small cat-opt';
        b.textContent = `${p.name} 的手牌猫`;
        b.onclick = () => {
          if (sel.length === 2) return;
          sel.push({ kind: 'hand', seat: p.seat });
          b.classList.add('sel');
          if (sel.length === 2) this.sendSwap(card, sel[0], sel[1]);
        };
        box.appendChild(b);
      }
    };
    m.querySelector('#tab-table').onclick = () => { sel.length = 0; drawTable(); };
    m.querySelector('#tab-hand').onclick = () => { sel.length = 0; drawHand(); };
    m.querySelector('#swap-cancel').onclick = () => this.closeModal();
    drawTable();
  }

  sendSwap(card, a, b) {
    this.closeModal();
    this.hooks.act('play', { cardId: card.id, targets: { a, b } });
  }

  // ---------- 保护 ----------
  openProtectModal(card) {
    const s = this.s;
    const me = s.players[this.mySeat];
    const m = this.openModal(`
      <h3>🛡 保护猫牌（触发数字 ${card.triggers[0]}）</h3>
      <div id="prot-body"></div>
      <button class="btn" id="prot-cancel">取消（空放）</button>
    `);
    const body = m.querySelector('#prot-body');
    body.innerHTML = '<div class="tg-row wrap" id="prot-opts"></div>';
    const box = body.querySelector('#prot-opts');
    // 保护自己的盖置猫牌
    me.cats.forEach((sl, i) => {
      const fd = (sl.cover && !sl.coverRevealed) || !sl.baseRevealed;
      if (!fd || sl.protected) return;
      const b = document.createElement('button');
      b.className = 'btn small';
      b.textContent = `猫牌 ${i + 1}`;
      b.onclick = () => {
        this.closeModal();
        this.hooks.act('play', { cardId: card.id, targets: { seat: this.mySeat, slot: i } });
      };
      box.appendChild(b);
    });
    // 可选规则：解除他人保护
    if (s.settings.protectOthers) {
      const br = document.createElement('div');
      br.className = 'tg-title';
      br.textContent = '解除他人保护：';
      box.appendChild(br);
      for (const p of s.players) {
        if (p.seat === this.mySeat || p.eliminated) continue;
        p.cats.forEach((sl, i) => {
          if (!sl.protected) return;
          const b = document.createElement('button');
          b.className = 'btn small';
          b.textContent = `${p.name} 猫${i + 1}`;
          b.onclick = () => {
            this.closeModal();
            this.hooks.act('play', { cardId: card.id, targets: { seat: p.seat, slot: i } });
          };
          box.appendChild(b);
        });
      }
    }
    m.querySelector('#prot-cancel').onclick = () => {
      this.closeModal();
      this.hooks.act('play', { cardId: card.id, targets: {} });
    };
  }

  // ---------- 禁言 ----------
  openMuteModal(card) {
    const s = this.s;
    const m = this.openModal(`
      <h3>🔇 禁言（触发数字 ${card.triggers.join(' / ')}）</h3>
      <p>选择目标玩家；选自己则摸 1 张牌（若被禁言则解除）</p>
      <div class="tg-row wrap" id="mute-opts"></div>
      <button class="btn" id="mute-cancel">取消</button>
    `);
    const box = m.querySelector('#mute-opts');
    for (const p of s.players) {
      if (p.eliminated) continue;
      const b = document.createElement('button');
      b.className = 'btn small';
      b.textContent = p.seat === this.mySeat ? '自己（摸1张）' : p.name;
      b.onclick = () => {
        this.closeModal();
        this.hooks.act('play', { cardId: card.id, targets: { seat: p.seat } });
      };
      box.appendChild(b);
    }
    m.querySelector('#mute-cancel').onclick = () => this.closeModal();
  }

  // ---------- 猜牌 ----------
  openGuessBuilder() {
    const s = this.s;
    const me = s.players[this.mySeat];
    // 第一步：同弹窗内选择弃置牌（总和=5）
    const targets = s.players.filter(p => p.seat !== this.mySeat && !p.eliminated);
    if (targets.length === 0) { this.hooks.err('没有可猜的玩家'); return; }
    const m = this.openModal(`
      <h3>🔍 猜牌</h3>
      <div class="guess-steps">
        <div class="gs-step">
          <div class="tg-title">1. 点击选择弃置的点数牌（总和须 = 5）</div>
          <div class="gs-sum" id="gs-sum">已选：0 / 5</div>
          <div class="tg-row wrap" id="gs-cards"></div>
        </div>
        <div class="gs-step">
          <div class="tg-title">2. 选择目标</div>
          <div class="tg-row wrap" id="gs-targets"></div>
        </div>
        <div class="gs-step">
          <div class="tg-title">3. 依次报出其猫牌颜色</div>
          <div id="gs-colors"></div>
        </div>
      </div>
      <button class="btn primary" id="gs-confirm" disabled>确认猜牌</button>
      <button class="btn" id="gs-cancel">取消</button>
    `, { wide: true, closable: true });
    const chosen = new Set();
    const sumEl = m.querySelector('#gs-sum');
    let targetSeat = null;
    let colors = [];

    const numCards = me.hand.filter(c => c.type === 'number');
    const cardBox = m.querySelector('#gs-cards');
    for (const c of numCards) {
      const b = document.createElement('button');
      b.className = `btn small mini-card ${colorClass(c)}`;
      b.innerHTML = cardFaceHTML(c);
      b.onclick = () => {
        if (chosen.has(c.id)) { chosen.delete(c.id); b.classList.remove('sel'); }
        else { chosen.add(c.id); b.classList.add('sel'); }
        let sum = 0;
        for (const id of chosen) sum += me.hand.find(x => x.id === id).point;
        sumEl.textContent = `已选：${sum} / 5`;
        upd();
      };
      cardBox.appendChild(b);
    }
    const tBox = m.querySelector('#gs-targets');
    for (const t of targets) {
      const b = document.createElement('button');
      b.className = 'btn small';
      b.textContent = t.name;
      b.onclick = () => {
        targetSeat = t.seat;
        tBox.querySelectorAll('button').forEach(x => x.classList.remove('sel'));
        b.classList.add('sel');
        drawColors();
      };
      tBox.appendChild(b);
    }
    const colorBox = m.querySelector('#gs-colors');
    const drawColors = () => {
      colorBox.innerHTML = '';
      colors = [];
      if (targetSeat == null) return;
      const t = s.players[targetSeat];
      const n = t.cats.filter(sl => (sl.cover && !sl.coverRevealed) || !sl.baseRevealed).length;
      colorBox.innerHTML = `<div class="tg-row" id="gs-colrow"></div>`;
      const row = colorBox.querySelector('#gs-colrow');
      for (let i = 0; i < n; i++) {
        const wrap = document.createElement('div');
        wrap.className = 'color-pick';
        wrap.innerHTML = `<span>第${i + 1}位</span>
          <button class="wp-btn color-white" data-c="white">白</button>
          <button class="wp-btn color-black" data-c="black">黑</button>`;
        colors.push(null);
        wrap.querySelector('[data-c="white"]').onclick = () => { colors[i] = 'white'; wrap.querySelectorAll('button').forEach(x => x.classList.remove('on')); wrap.querySelector('[data-c="white"]').classList.add('on'); upd(); };
        wrap.querySelector('[data-c="black"]').onclick = () => { colors[i] = 'black'; wrap.querySelectorAll('button').forEach(x => x.classList.remove('on')); wrap.querySelector('[data-c="black"]').classList.add('on'); upd(); };
        row.appendChild(wrap);
      }
      upd();
    };
    const upd = () => {
      let sum = 0;
      for (const id of chosen) sum += me.hand.find(x => x.id === id).point;
      const okColors = colors.length > 0 && colors.every(c => c != null);
      m.querySelector('#gs-confirm').disabled = !(sum === 5 && targetSeat != null && okColors);
    };
    m.querySelector('#gs-confirm').onclick = () => {
      this.closeModal();
      this.hooks.act('guess', { targetSeat, colors, discardIds: [...chosen] });
    };
    m.querySelector('#gs-cancel').onclick = () => this.closeModal();
  }

  onGuessSelectChange() {}

  // ---------- 反猜弹窗（由 render 检测 pending） ----------
  maybeOpenCounter() {
    const s = this.s;
    const c = s.pending && s.pending.counter;
    if (!c || c.targetSeat !== this.mySeat) { this.counterShown = 0; return; }
    if (this.counterShown === s.v) return;
    this.counterShown = s.v;
    const guesser = s.players[c.guessSeat];
    const me = s.players[this.mySeat];
    const m = this.openModal(`
      <h3>🔁 反猜！</h3>
      <p>${escapeHtml(guesser.name)} 猜错了你的猫牌，将被淘汰。<br>你可以弃 1 张牌，猜对 TA 的全部猫牌颜色则改为 TA 被淘汰。</p>
      <div class="tg-title">弃 1 张牌：</div>
      <div class="tg-row wrap" id="ct-cards"></div>
      <div class="tg-title">依次报出对方猫牌颜色：</div>
      <div id="ct-colors"></div>
      <div class="modal-btns">
        <button class="btn primary" id="ct-confirm" disabled>反猜！</button>
        <button class="btn warn" id="ct-decline">放弃反猜</button>
      </div>
    `, { closable: false, wide: true });
    const chosen = { id: null };
    const cardBox = m.querySelector('#ct-cards');
    for (const c of me.hand) {
      const b = document.createElement('button');
      b.className = `btn small mini-card ${colorClass(c)}`;
      b.innerHTML = cardFaceHTML(c);
      b.onclick = () => {
        cardBox.querySelectorAll('button').forEach(x => x.classList.remove('sel'));
        if (chosen.id === c.id) { chosen.id = null; } else { chosen.id = c.id; b.classList.add('sel'); }
        upd();
      };
      cardBox.appendChild(b);
    }
    const gCats = guesser.cats.filter(sl => (sl.cover && !sl.coverRevealed) || !sl.baseRevealed).length;
    const colors = new Array(gCats).fill(null);
    const colorBox = m.querySelector('#ct-colors');
    colorBox.innerHTML = '<div class="tg-row" id="ct-colrow"></div>';
    const row = colorBox.querySelector('#ct-colrow');
    for (let i = 0; i < gCats; i++) {
      const wrap = document.createElement('div');
      wrap.className = 'color-pick';
      wrap.innerHTML = `<span>第${i + 1}位</span>
        <button class="wp-btn color-white" data-c="white">白</button>
        <button class="wp-btn color-black" data-c="black">黑</button>`;
      wrap.querySelector('[data-c="white"]').onclick = () => { colors[i] = 'white'; wrap.querySelectorAll('button').forEach(x => x.classList.remove('on')); wrap.querySelector('[data-c="white"]').classList.add('on'); upd(); };
      wrap.querySelector('[data-c="black"]').onclick = () => { colors[i] = 'black'; wrap.querySelectorAll('button').forEach(x => x.classList.remove('on')); wrap.querySelector('[data-c="black"]').classList.add('on'); upd(); };
      row.appendChild(wrap);
    }
    const upd = () => {
      m.querySelector('#ct-confirm').disabled = !(chosen.id && colors.every(c => c != null));
    };
    m.querySelector('#ct-confirm').onclick = () => {
      this.closeModal();
      this.hooks.act('counter', { payload: { discardCardId: chosen.id, colors } });
    };
    m.querySelector('#ct-decline').onclick = () => {
      this.closeModal();
      this.hooks.act('counter', { payload: { decline: true } });
    };
  }

  // ---------- 盖猫 ----------
  openCoverPicker(me) {
    const s = this.s;
    const slots = [];
    me.cats.forEach((sl, i) => { if (sl.baseRevealed && !sl.cover) slots.push(i); });
    if (slots.length === 0) return;
    if (slots.length === 1) {
      this.hooks.act('cover', { slot: slots[0] });
      return;
    }
    const m = this.openModal(`
      <h3>📦 盖猫续命</h3>
      <p>将手牌猫盖到已翻开的猫位上（下家摸 2 张）</p>
      <div class="tg-row wrap" id="cover-opts"></div>
      <button class="btn" id="cover-cancel">取消</button>
    `);
    const box = m.querySelector('#cover-opts');
    for (const i of slots) {
      const b = document.createElement('button');
      b.className = 'btn small';
      b.textContent = `猫位 ${i + 1}`;
      b.onclick = () => { this.closeModal(); this.hooks.act('cover', { slot: i }); };
      box.appendChild(b);
    }
    m.querySelector('#cover-cancel').onclick = () => this.closeModal();
  }

  // ---------- 事件动画 ----------
  queryableFlush(seq, evs) {
    // 事件驱动的一次性视觉
    const s = this.s;
    const me = this.mySeat;
    const deckEl = $('draw-pile');
    const deckRect = deckEl.getBoundingClientRect();

    const flyCardToDiscard = (card) => {
      const pile = $('discard-pile');
      const pr = pile.getBoundingClientRect();
      const ghost = document.createElement('div');
      ghost.className = 'card card-face ghost ' + colorClass(card);
      ghost.innerHTML = cardFaceHTML(card);
      ghost.style.left = deckRect.left - 40 + 'px';
      ghost.style.top = deckRect.top + 'px';
      ghost.style.zIndex = 999;
      document.body.appendChild(ghost);
      const gr = ghost.getBoundingClientRect();
      ghost.animate([
        { transform: 'translate(0px, 30px) rotate(-8deg) scale(.85)', opacity: 0.9 },
        { transform: `translate(${pr.left - gr.left + pr.width / 2}px, ${pr.top - gr.top}px) rotate(6deg) scale(1)`, opacity: 1 },
      ], { duration: 380, easing: 'cubic-bezier(.2,.8,.3,1)' });
      setTimeout(() => { ghost.remove(); }, 400);
    };

    evs.forEach((ev) => {
      this.animQueue.push(ev);
    });
    if (this.animBusy) return;
    this.animBusy = true;
    const d = (ms) => new Promise(r => setTimeout(r, ms));
    (async () => {
      while (this.animQueue.length) {
        const ev = this.animQueue.shift();
        switch (ev.t) {
          case 'play': flyCardToDiscard(ev.card); await d(90); break;
          case 'reveal': {
            const z = ev.seat === me ? document.querySelector(`#my-cats .catslot[data-cat-idx="${ev.slot}"]`) : this.zoneFor(ev.seat) && this.zoneFor(ev.seat).querySelector(`.catslot[data-cat-idx="${ev.slot}"]`);
            if (z) { z.classList.add('flippy'); }
            await d(420); break;
          }
          case 'eliminate': {
            this.hooks.toast(`💀 ${escapeHtml(s.players[ev.seat].name)} 被淘汰（${ev.reason === 'cats' ? '猫牌全翻' : ev.reason === 'guess' ? '被猜中' : ev.reason === 'counter' ? '被反猜中' : ev.reason === 'dc' ? '掉线' : '猜错'}）`);
            await d(600); break;
          }
          case 'guess': {
            const winnerSide = ev.ok ? '猜中！' : '猜错…';
            this.hooks.toast(`${s.players[ev.guessSeat].name} 猜 ${s.players[ev.targetSeat].name}：${ev.colors.map(c => c === 'white' ? '白' : '黑').join(' ')} — ${winnerSide}`);
            await d(500); break;
          }
          case 'counter': {
            if (ev.ok != null) this.hooks.toast(ev.ok ? '反猜成功！' : ev.declined ? '放弃反猜' : '反猜失败');
            await d(500); break;
          }
          case 'peek': {
            if (ev.by === me) {
              const m = this.openModal(`
                <h3>👁 你看到了</h3>
                <div class="peek-show">${catFaceHTML(ev.cat)}</div>
                <p>${ev.kind === 'hand' ? '手牌猫' : '桌面猫牌'}：${catName(ev.cat)}</p>
                <button class="btn primary" id="peek-ok">记住它！</button>
              `);
              m.querySelector('#peek-ok').onclick = () => this.closeModal();
            }
            await d(300); break;
          }
          case 'round': {
            this.hooks.toast(`🀄 第${ev.round}局开始`);
            await d(700); break;
          }
          case 'gameover': {
            await d(400);
            this.openModal(`
              <h3>🏆 游戏结束</h3>
              <p class="winner-text">${escapeHtml(ev.name)} 获得胜利！</p>
              <button class="btn primary" id="go-ok">好的</button>
            `, { closable: false });
            const b = document.querySelector('#go-ok');
            if (b) b.onclick = () => this.closeModal();
            await d(400); break;
          }
          case 'turn': {
            const cur = s.players[ev.seat];
            if (cur && cur.seat === me) this.hooks.toast('▶ 轮到你');
            await d(200); break;
          }
          case 'mute': {
            this.hooks.toast(`${s.players[ev.by].name} 禁言了 ${s.players[ev.targetSeat].name}`);
            await d(200); break;
          }
          default: await d(60);
        }
      }
      this.animBusy = false;
    })();
    void seq;

    // 反猜弹窗
    this.maybeOpenCounter();
  }
}

// ---------- 牌面 HTML（美术图 + 万能牌指定标记） ----------
export function colorClass(card) {
  if (card.type === 'wild' || card.color === 'gray') return 'c-gray';
  return card.color === 'white' ? 'c-white' : 'c-black';
}

export function cardFaceHTML(card) {
  let html = `<img class="card-img" src="assets/cards/${card.img || 'back-card'}.png" alt="${cardName(card)}" draggable="false">`;
  if (card.type === 'wild' && card.assignedColor != null) {
    html += `<span class="wild-claim ${card.assignedColor === WHITE ? 'c-white' : 'c-black'}">${card.assignedColor === WHITE ? '白' : '黑'}${card.assignedPoint}</span>`;
  }
  return html;
}

export function catFaceHTML(cat) {
  return `<img class="cat-img" src="assets/cards/cat-${cat.color === WHITE ? 'w' : 'b'}${cat.point}.png" alt="${catName(cat)}" draggable="false">`;
}

export function backHTML() {
  return `<img class="card-img" src="assets/cards/back-card.png" alt="卡背" draggable="false">`;
}

export function catBackHTML() {
  return `<img class="catback-img" src="assets/cards/back-cat.png" alt="猫牌背" draggable="false">`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}