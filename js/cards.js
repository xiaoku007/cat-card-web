// cards.js —— 牌组定义（93 张主牌 + 12 张猫牌）
'use strict';

import { shuffle } from './util.js';

export const WHITE = 'white';
export const BLACK = 'black';
export const GRAY = 'gray';

export const FUNC_DRAW = 'draw';        // 摸牌
export const FUNC_PEEK = 'peek';        // 观看
export const FUNC_SWAP = 'swap';        // 互换
export const FUNC_PROTECT = 'protect';  // 保护
export const FUNC_MUTE = 'mute';        // 禁言

// 构造主牌堆：白/黑 1~5 点数牌各 6；白/黑 5 种功能牌各 3；灰色万能牌 3 —— 共 93 张
export function buildMainDeck(rng = Math.random) {
  const d = [];
  let seq = 0;
  const mk = (color, type, point = 0, func = null, triggers = []) => ({
    id: 'c' + (seq++),
    color, type, point, func, triggers,
  });
  const funcs = [FUNC_DRAW, FUNC_PEEK, FUNC_SWAP, FUNC_PROTECT, FUNC_MUTE];
  const ri = () => 1 + Math.floor(rng() * 5);
  for (const color of [WHITE, BLACK]) {
    for (let p = 1; p <= 5; p++) {
      for (let i = 0; i < 6; i++) d.push(mk(color, 'number', p));
    }
    for (const f of funcs) {
      for (let i = 0; i < 3; i++) {
        if (f === FUNC_PROTECT) d.push(mk(color, 'function', 0, f, [ri()]));
        else if (f === FUNC_MUTE) d.push(mk(color, 'function', 0, f, [ri(), ri()]));
        else d.push(mk(color, 'function', 0, f));
      }
    }
  }
  for (let i = 0; i < 3; i++) d.push(mk(GRAY, 'wild'));
  return shuffle(d, rng);
}

// 猫牌组：白 2/3/4 各 2、黑 2/3/4 各 2 —— 共 12 张
export function buildCatDeck(rng = Math.random) {
  const d = [];
  let seq = 0;
  for (const color of [WHITE, BLACK]) {
    for (let p = 2; p <= 4; p++) {
      for (let i = 0; i < 2; i++) d.push({ id: 'k' + (seq++), color, point: p });
    }
  }
  return shuffle(d, rng);
}

// 判定能否打出：card 打在 last 上
export function canPlayOn(card, last) {
  if (!card) return false;
  if (card.type === 'wild') return true;
  if (!last) return true;
  // 万能牌按打出的自定义颜色与点数视为点数牌
  let lc = last.color, lp = last.point, lkind = last.type;
  if (last.type === 'wild') {
    if (last.assignedColor == null) return false; // 尚未选择颜色，阻塞出牌
    lc = last.assignedColor; lp = last.assignedPoint; lkind = 'number';
  }
  if (lkind === 'function') {
    return card.color === lc;
  }
  // 上家为点数牌
  if (card.type === 'number') {
    if (lc === WHITE) return card.color === WHITE && card.point < lp;
    return card.color === BLACK && card.point > lp;
  }
  if (card.type === 'function') {
    return card.color === lc;
  }
  return false;
}

// 牌面描述
export function cardName(card) {
  if (card.type === 'wild') return '灰色万能牌';
  const c = card.color === WHITE ? '白' : (card.color === BLACK ? '黑' : '灰');
  if (card.type === 'number') return `${c}${card.point}`;
  const fnames = {
    [FUNC_DRAW]: '摸牌', [FUNC_PEEK]: '观看', [FUNC_SWAP]: '互换',
    [FUNC_PROTECT]: '保护', [FUNC_MUTE]: '禁言',
  };
  return `${c}·${fnames[card.func]}` + (card.triggers.length ? `(${card.triggers.join('/')})` : '');
}

export function catName(cat) {
  return (cat.color === WHITE ? '白' : '黑') + cat.point;
}