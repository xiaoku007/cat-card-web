// ui.js —— 大厅界面
'use strict';

export class LobbyUI {
  constructor(hooks) {
    // hooks: { onCreate(name, settings), onJoin(code, name), onReady(), onStart(),
    //          onSettings(settings), onLeave(), onCopyLink() }
    this.hooks = hooks;
    this.settings = {
      extraCats2or3: true, handCatRule: true, protectOthers: true, eliminationMode: true,
    };
    this.nick = localStorage.getItem('catcard-nick') || '';

    this.el = {
      nick: document.getElementById('nick-input'),
      create: document.getElementById('btn-create'),
      room: document.getElementById('room-input'),
      join: document.getElementById('btn-join'),
      hint: document.getElementById('lobby-hint'),
      panel: document.getElementById('room-panel'),
      code: document.getElementById('room-code'),
      copy: document.getElementById('btn-copy'),
      toggles: document.getElementById('host-toggles'),
      guestSettings: document.getElementById('guest-settings'),
      seats: document.getElementById('seat-list'),
      ready: document.getElementById('btn-ready'),
      start: document.getElementById('btn-start'),
      leave: document.getElementById('btn-leave-lobby'),
    };
    this.el.nick.value = this.nick;
    this.el.create.onclick = () => this.doCreate();
    this.el.join.onclick = () => this.doJoin();
    this.el.copy.onclick = () => { this.hooks.onCopyLink(); };
    this.el.ready.onclick = () => this.hooks.onReady();
    this.el.start.onclick = () => this.hooks.onStart();
    this.el.leave.onclick = () => this.hooks.onLeave();
    this.el.nick.oninput = () => {
      const name = this.el.nick.value.trim().slice(0, 12);
      localStorage.setItem('catcard-nick', name);
      this.nick = name;
    };

    // 规则开关
    const tgs = {
      'tg-cats4': 'extraCats2or3', 'tg-handcat': 'handCatRule',
      'tg-unprotect': 'protectOthers', 'tg-elimination': 'eliminationMode',
    };
    for (const [id, key] of Object.entries(tgs)) {
      const el = document.getElementById(id);
      el.onchange = () => {
        this.settings[key] = el.checked;
        this.hooks.onSettings({ ...this.settings });
      };
    }
  }

  getSettings() { return { ...this.settings }; }

  setSettings(s) {
    this.settings = { ...this.settings, ...s };
    document.getElementById('tg-cats4').checked = !!s.extraCats2or3;
    document.getElementById('tg-handcat').checked = !!s.handCatRule;
    document.getElementById('tg-unprotect').checked = !!s.protectOthers;
    document.getElementById('tg-elimination').checked = !!s.eliminationMode;
  }

  doCreate() {
    const name = this.nickName();
    if (!name) { this.hint('请输入昵称'); return; }
    this.hooks.onCreate(name, this.settings);
  }

  doJoin() {
    const name = this.nickName();
    const code = this.el.room.value.trim().toUpperCase();
    if (!name) { this.hint('请输入昵称'); return; }
    if (!/^[A-Z0-9]{5}$/.test(code)) { this.hint('房间码为 5 位字母/数字'); return; }
    this.hooks.onJoin(code, name);
  }

  nickName() {
    const v = this.el.nick.value.trim().slice(0, 12);
    return v || ('玩家' + Math.floor(Math.random() * 1000));
  }

  hint(t) {
    if (!t) { this.el.hint.textContent = ''; return; }
    this.el.hint.textContent = t;
    setTimeout(() => { if (this.el.hint.textContent === t) this.el.hint.textContent = ''; }, 2600);
  }

  showRoom(code, isHost, state) {
    document.getElementById('screen-lobby').classList.remove('hidden');
    document.getElementById('screen-game').classList.add('hidden');
    this.el.panel.classList.remove('hidden');
    this.el.code.textContent = code;
    if (isHost) {
      this.el.toggles.classList.remove('hidden');
      this.el.start.classList.remove('hidden');
      this.el.ready.classList.add('hidden');
    } else {
      this.el.toggles.classList.add('hidden');
      this.el.start.classList.add('hidden');
      this.el.ready.classList.remove('hidden');
      // 展示当前生效规则
      const s = state.settings || {};
      const names = [
        s.extraCats2or3 && '2/3人4猫牌', s.handCatRule && '手牌猫', s.protectOthers && '解除保护', s.eliminationMode && '淘汰制',
      ].filter(Boolean);
      this.el.guestSettings.textContent = names.length ? '本局规则：' + names.join(' · ') : '';
    }
    this.renderSeats(state, isHost);
  }

  renderSeats(state, isHost) {
    const box = this.el.seats;
    box.innerHTML = '';
    state.players.forEach((p) => {
      const row = document.createElement('div');
      row.className = 'seat-row' + (p.seat === 0 ? ' host' : '') + (p.connected ? '' : ' offline');
      row.innerHTML = `
        <span class="seat-idx">${p.seat + 1}号位</span>
        <span class="seat-name">${escapeHtml(p.name)}${p.eliminated ? '（已淘汰）' : ''}</span>
        <span class="seat-conn">${p.connected ? '' : '断线'}</span>
        <span class="seat-flag">${state.hostSeat === p.seat ? '👑房主' : (p.ready ? '✓已准备' : '未准备')}</span>
      `;
      box.appendChild(row);
    });
    if (isHost) {
      const canStart = state.players.length >= 2;
      this.el.start.disabled = !canStart;
      this.el.start.textContent = canStart ? `开始游戏（${state.players.length} 人）` : '至少需要 2 名玩家';
    } else {
      this.el.ready.textContent = '已准备 ✓';
      const me = state.players.find(p => p.id === this.hooks.myId());
      this.el.ready.classList.toggle('done', !!(me && me.ready));
    }
  }

  hideRoom() {
    this.el.panel.classList.add('hidden');
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}