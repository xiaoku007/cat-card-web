// util.js —— 通用工具
'use strict';

export function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export function shuffle(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

export function nextAliveSeat(state, fromSeat, step) {
  const n = state.players.length;
  let s = fromSeat;
  for (let i = 0; i < n; i++) {
    s = (s + step + n) % n;
    if (state.players[s] && !state.players[s].eliminated) return s;
  }
  return -1;
}

export function livingPlayers(state) {
  return state.players.filter(p => !p.eliminated);
}

export function seatName(state, seat) {
  const p = state.players[seat];
  return p ? p.name : '?';
}

// 邻座（左右最近存活玩家，不含自己；不足时可能为空数组）
export function neighborSeats(state, seat) {
  const out = [];
  const n = state.players.length;
  const left = nextAliveSeat(state, seat, 1);
  const right = nextAliveSeat(state, seat, -1);
  if (left !== -1 && left !== seat) out.push(left);
  if (right !== -1 && right !== seat && !out.includes(right)) out.push(right);
  return out;
}

export function delay(ms) {
  return new Promise(res => setTimeout(res, ms));
}