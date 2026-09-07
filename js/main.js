// main.js —— 入口：接入网络层、大厅与游戏 UI
'use strict';

import { GameNet, parseUrl } from './net.js';
import { LobbyUI } from './ui.js';
import { GameUI } from './gameui.js';

const $ = (id) => document.getElementById(id);
const urlp = parseUrl();

// ---------- 提示 ----------
function toast(msg, ms = 2600) {
  const root = $('toast-root');
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  root.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, ms);
}

function err(msg) { toast('⚠ ' + msg, 3000); }

// ---------- 状态栏 ----------
function setConnStatus(cls, text) {
  const el = $('conn-status');
  el.className = cls;
  el.title = text;
}

const PHASE_NAMES = {
  lobby: '大厅', arrange: '摆猫阶段', direction: '选择出牌顺序',
  playing: '对局中', matchover: '对局结束',
};

// ---------- 会话 ----------
let myId = null;
let mySeat = -1;
let lastReady = false;

// ---------- 网络 ----------
const net = new GameNet({
  onSync: (state) => route(state),
  onStatus: (st, info) => {
    switch (st) {
      case 'connecting': setConnStatus('warn', '连接中…'); break;
      case 'online': setConnStatus('ok', '已连接');
        if (info === 'host') toast('房间已创建，快邀请朋友吧！');
        if (info === 'migrated-host') toast('主机掉线，你已成为新主机');
        break;
      case 'reconnecting': setConnStatus('warn', '重连中…'); toast('连接中断，正在重连…', 2000); break;
      case 'hostdown': setConnStatus('bad', '主机掉线'); toast('主机掉线，无法继续', 4000); break;
      case 'error': setConnStatus('bad', '错误'); toast(info, 4000); break;
      case 'bye': setConnStatus('off', '已离开'); break;
    }
  },
  onErr: err,
});
if (urlp.signal) net.setSignal(urlp.signal);

// 将欢迎消息中的身份同步回来
const netOnSync = net.cb.onSync.bind(net.cb);
net.cb.onSync = (state) => {
  if (net.amHosting) { myId = net.myId; mySeat = net.mySeat; }
  else if (net.myId) {
    myId = net.myId;
    const me = state.players.find(p => p.id === net.myId);
    if (me) { mySeat = me.seat; lastReady = !!me.ready; }
  }
  netOnSync(state);
};

// ---------- UI ----------
const lobby = new LobbyUI({
  onCreate: async (name, settings) => {
    const { code } = await net.createRoom(name, settings);
    history.replaceState(null, '', location.pathname + '?room=' + code);
  },
  onJoin: (code, name) => {
    history.replaceState(null, '', location.pathname + '?room=' + code);
    net.joinRoom(code, name);
  },
  onReady: () => net.act('ready', { ready: !lastReady }),
  onStart: () => net.act('start', {}),
  onSettings: (settings) => net.act('settings', { settings }),
  onLeave: () => { net.leaveRoom(); location.href = location.pathname; },
  onCopyLink: () => {
    const link = location.origin + location.pathname + '?room=' + net.roomId;
    if (navigator.clipboard) navigator.clipboard.writeText(link).then(() => toast('邀请链接已复制 ✓'));
    else toast(link, 5000);
  },
  myId: () => myId,
});

const game = new GameUI({
  act: (type, payload) => net.act(type, payload),
  err, toast,
  isHost: () => net.amHosting,
  mySeat: () => mySeat,
});

// ---------- 路由 ----------
function route(state) {
  if (!state) return;
  $('game-phase-text').textContent = PHASE_NAMES[state.phase] || state.phase;
  if (state.phase === 'lobby') {
    $('screen-game').classList.add('hidden');
    $('screen-lobby').classList.remove('hidden');
    lobby.showRoom(net.roomId || '', net.amHosting, state);
  } else {
    $('screen-lobby').classList.add('hidden');
    $('screen-game').classList.remove('hidden');
    game.render(state);
  }
}

// ---------- 自动加入 ----------
const savedName = localStorage.getItem('catcard-nick') || '';
if (urlp.room) {
  setTimeout(() => {
    if (urlp.name) $('nick-input').value = urlp.name;
    const name = urlp.name || savedName;
    if (name) net.joinRoom(urlp.room, name);
    else toast('请输入昵称后点击「加入」', 3500);
  }, 200);
}