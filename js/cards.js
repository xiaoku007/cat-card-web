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
// 牌面美术取自 assets/cards/（img 字段）；保护触发数字固定 2/3/4，禁言数字对按成品图固定
export function buildMainDeck(rng = Math.random) {
  const d = [];
  let seq = 0;
  const mk = (color, type, point = 0, func = null, triggers = [], img) => ({
    id: 'c' + (seq++),
    color, type, point, func, triggers, img,
  });
  const cw = (color) => (color === WHITE ? 'w' : 'b');
  const funcs = [
    { f: FUNC_DRAW, key: 'split' },
    { f: FUNC_PEEK, key: 'peek' },
    { f: FUNC_SWAP, key: 'swap' },
  ];
  const MUTE_PAIRS = {
    [WHITE]: [[5, 1], [4, 2], [4, 3]],
    [BLACK]: [[5, 1], [3, 2], [4, 2]],
  };
  const MUTE_KEYS = {
    [WHITE]: ['mute15', 'mute24', 'mute34'],
    [BLACK]: ['mute15', 'mute23', 'mute24'],
  };
  for (const color of [WHITE, BLACK]) {
    const c = cw(color);
    for (let p = 1; p <= 5; p++) {
      for (let i = 0; i < 6; i++) d.push(mk(color, 'number', p, null, [], `${c}${p}`));
    }
    // 分裂(摸牌)/交换(互换)/观看 各 3 张
    for (const { f, key } of funcs) {
      for (let i = 0; i < 3; i++) d.push(mk(color, 'function', 0, f, [], `${c}-${key}`));
    }
    // 保护：触发数字 2/3/4 各 1 张（共 3 张）
    for (const t of [2, 3, 4]) d.push(mk(color, 'function', 0, FUNC_PROTECT, [t], `${c}-shield${t}`));
    // 禁言：数字对按成品图
    for (let i = 0; i < 3; i++) {
      const pair = MUTE_PAIRS[color][i];
      d.push(mk(color, 'function', 0, FUNC_MUTE, pair, `${c}-${MUTE_KEYS[color][i]}`));
    }
  }
  for (let i = 0; i < 3; i++) d.push(mk(GRAY, 'wild', 0, null, [], 'wild'));
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
  if (card.type === 'wild') {
    const base = '灰色万能牌';
    if (card.assignedColor != null) return base + `（${card.assignedColor === WHITE ? '白' : '黑'}${card.assignedPoint}）`;
    return base;
  }
  const c = card.color === WHITE ? '白' : (card.color === BLACK ? '黑' : '灰');
  if (card.type === 'number') return `${c}${card.point}`;
  const fnames = {
    [FUNC_DRAW]: '摸牌', [FUNC_PEEK]: '观看', [FUNC_SWAP]: '互换',
    [FUNC_PROTECT]: '保护', [FUNC_MUTE]: '禁言',
  };
  return `${c}·${fnames[card.func]}` + (card.triggers.length ? `(${card.triggers.join('/')})` : '');
}

// 卡牌悬停说明（美术图无文字，辅助提示用）
export function cardTitle(card) {
  if (card.type === 'wild') {
    return card.assignedColor == null
      ? '灰色万能牌：任意时刻打出，打出自定义颜色和点数'
      : `灰色万能牌：已指定为 ${card.assignedColor === WHITE ? '白' : '黑'}${card.assignedPoint}`;
  }
  if (card.type === 'number') {
    return `${card.color === WHITE ? '白' : '黑'}${card.point}（点数牌）`;
  }
  const c = card.color === WHITE ? '白' : '黑';
  const f = {
    [FUNC_DRAW]: `${c}·摸牌：打出者摸 1 张；若已有翻开的猫牌则额外再摸 1 张`,
    [FUNC_PEEK]: `${c}·观看：观看邻家或自己的一张盖置猫牌（可为手牌猫）`,
    [FUNC_SWAP]: `${c}·互换：互换两张盖置未保护的桌面猫牌，或两张手牌猫`,
    [FUNC_PROTECT]: `${c}·保护：盖在自己一张盖置猫牌上；打出数字 ${card.triggers[0]} 的点数牌或万能牌时失效`,
    [FUNC_MUTE]: `${c}·禁言：目标无法猜牌、得不到淘汰奖励；打出同色 ${card.triggers.join(' 或 ')} 或万能牌时失效`,
  }[card.func];
  return f;
}

export function catName(cat) {
  return (cat.color === WHITE ? '白' : '黑') + cat.point;
}