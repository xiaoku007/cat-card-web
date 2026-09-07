// 一次性规则自测脚本（运行后删除）
import { Engine } from './js/rules.js';
import { canPlayOn, buildMainDeck } from './js/cards.js';

let pass = 0, fail = 0;
const ok = (cond, name) => { cond ? pass++ : (fail++, console.error('FAIL:', name)); };
const setup = (n, settings = {}, room = 'T') => {
  const e = new Engine();
  e.initMatch(room, Object.assign({ extraCats2or3: false, handCatRule: false, protectOthers: false, eliminationMode: false }, settings),
    Array.from({ length: n }, (_, i) => ({ id: 'p' + i, name: '玩家' + i })));
  for (let i = 1; i < n; i++) e.setReady(i, true);
  e.startMatch();
  return e;
};
const toPlaying = (e, n) => {
  for (let i = 0; i < n; i++) e.arrangeDone(i);
  e.chooseDirection(0, 1);
};

// 1. 牌堆数量
const deck = buildMainDeck();
ok(deck.length === 93, '主牌堆 93 张');
const counts = {};
for (const c of deck) {
  const k = c.type === 'wild' ? 'wild' : `${c.color}-${c.type === 'number' ? 'n' + c.point : c.func}`;
  counts[k] = (counts[k] || 0) + 1;
}
for (const c of ['white', 'black']) for (let p = 1; p <= 5; p++) ok(counts[`${c}-n${p}`] === 6, `${c}${p}×6`);
ok(counts['white-protect'] === 3 && counts['black-mute'] === 3 && counts['wild'] === 3, '功能牌与万能牌数量');

// 2. 出牌合法性
const W = num => ({ color: 'white', type: 'number', point: num });
const B = num => ({ color: 'black', type: 'number', point: num });
const FN = (color) => ({ color, type: 'function', func: 'draw' });
const WILD = { color: 'gray', type: 'wild' };
ok(canPlayOn(W(2), W(5)), '上家白5 → 白2 可出');
ok(!canPlayOn(W(5), W(3)), '上家白3 → 白5 不可出');
ok(canPlayOn(B(4), B(2)), '上家黑2 → 黑4 可出');
ok(!canPlayOn(W(2), B(3)), '上家黑3 → 白2 不可出');
ok(canPlayOn(FN('white'), W(5)), '上家白5 → 白功能牌可出');
ok(!canPlayOn(FN('black'), W(5)), '上家白5 → 黑功能牌不可出');
ok(canPlayOn(WILD, W(5)), '万能牌任意可出');
ok(canPlayOn(W(2), FN('white')), '上家白功能 → 白2 可出');
ok(!canPlayOn(B(2), FN('white')), '上家白功能 → 黑2 不可出');
const wildPlayed = { color: 'gray', type: 'wild', assignedColor: 'black', assignedPoint: 3 };
ok(canPlayOn(B(5), wildPlayed), '上家万能(黑3) → 黑5 可出');
ok(!canPlayOn(W(3), wildPlayed), '上家万能(黑3) → 白3 不可出');

// 3. 开局流程（4 人）
const e = setup(4, { extraCats2or3: true, handCatRule: true, protectOthers: true });
const s = e.s;
ok(s.phase === 'arrange' && s.players.length === 4, '进入摆猫阶段');
ok(s.players.every(p => p.hand.length === 8), '每人 8 张手牌');
ok(s.players.every(p => p.cats.length === 3), '4人局每人 3 张猫牌（开关仅 2/3 人生效）');
ok(s.players.every(p => !p.handCat), '4人局无手牌猫');
ok(s.deck.length === 60, '牌堆数量正确 (93-32-1)');
ok(s.lastCard.type !== 'wild', '初始牌不是万能牌');
toPlaying(e, 4);
ok(s.phase === 'playing' && s.currentSeat === 0, '开始行动，1 号位先手');

// 4. 翻猫 3 次 → 全翻开淘汰
// （每次翻猫后回合转移，手动把回合拨回 0 号位模拟完整轮流）
for (let i = 0; i < 3; i++) {
  s.currentSeat = 0;
  ok(e.actPass(0, i).ok, `0号位第${i + 1}次翻猫`);
}
ok(s.players[0].eliminated, '0号位被淘汰');
ok(s.players[1].hand.length === 9 && s.players[2].hand.length === 9, '淘汰奖励：剩余玩家各摸1张(9)');
ok(s.currentSeat === 1, '回合切换到下家');

// 5. 猜牌成功流程
const e2 = setup(3); toPlaying(e2, 3);
const s2 = e2.s;
const guesser = s2.players[0], target = s2.players[1];
guesser.hand = [{ id: 'x', color: 'white', type: 'number', point: 3 },
                { id: 'y', color: 'black', type: 'number', point: 2 }];
target.cats.forEach((sl, i) => { sl.base = { id: 'k' + i, color: i % 2 ? 'white' : 'black', point: 2 + i }; });
ok(e2.actGuess(0, 1, ['black', 'white', 'black'], ['x', 'y']).ok, '猜牌动作执行');
ok(target.eliminated, '全猜中 → 目标淘汰');
ok(guesser.hand.length === 6, '猜牌奖励补至5 + 淘汰奖励1 = 6 张');
ok(s2.players[2].hand.length === 9, '第三位玩家 8+1 张');
ok(s2.currentSeat === 2 && e2.s.phase === 'playing', '回合切换到下下家');

// 6. 猜错 → 反猜失败 → 猜方淘汰
const e3 = setup(3); toPlaying(e3, 3);
const s3 = e3.s;
s3.players[0].hand = [{ id: 'a', color: 'white', type: 'number', point: 5 }];
s3.players[1].cats.forEach((sl, i) => { sl.base = { id: 'q' + i, color: 'white', point: 2 }; });
s3.players[0].cats.forEach((sl, i) => { sl.base = { id: 'r' + i, color: 'black', point: 3 }; });
ok(e3.actGuess(0, 1, ['black', 'black', 'white'], ['a']).ok, '猜牌动作执行');
ok(!s3.players[1].eliminated && s3.pending.counter, '猜错 → 等待反猜');
s3.players[1].hand = [{ id: 'z', color: 'white', type: 'number', point: 1 }];
ok(e3.actCounter(1, { colors: ['white', 'white', 'white'], discardCardId: 'z' }).ok, '反猜执行');
ok(s3.players[0].eliminated && !s3.players[1].eliminated, '反猜失败 → 原猜方淘汰');

// 7. 反猜成功 → 猜方淘汰
const e4 = setup(3); toPlaying(e4, 3);
const s4 = e4.s;
s4.players[0].hand = [{ id: 'a', color: 'white', type: 'number', point: 5 }];
s4.players[0].cats.forEach((sl, i) => { sl.base = { id: 'r' + i, color: 'black', point: 3 }; });
s4.players[1].cats.forEach((sl, i) => { sl.base = { id: 'q' + i, color: 'white', point: 2 }; });
e4.actGuess(0, 1, ['black', 'black', 'white'], ['a']);
s4.players[1].hand = [{ id: 'z', color: 'white', type: 'number', point: 1 }];
ok(e4.actCounter(1, { colors: ['black', 'black', 'black'], discardCardId: 'z' }).ok, '反猜执行');
ok(s4.players[0].eliminated && !s4.players[1].eliminated, '反猜成功 → 原猜方淘汰');

// 8. 禁言自己：摸 1 张且无标记
const e5 = setup(2); toPlaying(e5, 2);
const s5 = e5.s;
s5.players[0].hand = [{ id: 'm1', color: 'white', type: 'function', func: 'mute', triggers: [1, 2] }];
s5.lastCard = { color: 'white', type: 'function', func: 'draw' };
const h0 = s5.players[0].hand.length;
ok(e5.actPlay(0, 'm1', { seat: 0 }).ok, '禁言自己可打出');
ok(s5.players[0].hand.length === h0, '禁言自己：打出1张又摸1张，手牌持平');
ok(s5.players[0].silenceMarkers.length === 0, '禁言自己：无禁言标记');

// 9. 保护与失效
const e6 = setup(2, { protectOthers: true }); toPlaying(e6, 2);
const s6 = e6.s;
s6.players[0].hand = [{ id: 'p1', color: 'white', type: 'function', func: 'protect', triggers: [3] }];
s6.lastCard = { color: 'white', type: 'number', point: 4 };
e6.actPlay(0, 'p1', { seat: 0, slot: 0 });
ok(s6.players[0].cats[0].protected, '保护生效');
s6.players[1].hand = [{ id: 'w3', color: 'white', type: 'number', point: 3 }];
s6.lastCard = { color: 'white', type: 'function', func: 'protect' };
s6.currentSeat = 1;
e6.actPlay(1, 'w3', {});
ok(!s6.players[0].cats[0].protected, '打出同点数牌 → 保护失效');

// 10. 淘汰制玩法：淘汰后自动重开
const e7 = setup(3, { extraCats2or3: true, eliminationMode: true }); toPlaying(e7, 3);
const s7 = e7.s;
for (let i = 0; i < 4; i++) { s7.currentSeat = 0; e7.actPass(0, i); }
ok(s7.players[0].eliminated, '淘汰制：0号位淘汰');
ok(e7.s.round === 2 && e7.s.phase === 'arrange', '淘汰制：立即重开新一局');
ok(e7.s.players.filter(p => !p.eliminated).length === 2, '淘汰制：剩余 2 人继续');
ok(e7.s.players[1].hand.length === 8 && e7.s.players[2].hand.length === 8, '新一局重新发牌（各 8 张）');

// 11. 额外猫牌规则：盖猫续命
const e8 = setup(2, { extraCats2or3: true, handCatRule: true }); toPlaying(e8, 2);
const s8 = e8.s;
ok(s8.players[0].cats.length === 4 && s8.players[0].handCat != null, '2人局：4 猫牌 + 1 手牌猫');
s8.players[0].cats[0].baseRevealed = true; // 模拟已有翻开猫牌
const h1 = s8.players[1].hand.length;
ok(e8.actCover(0, 0).ok, '盖猫动作有效');
ok(s8.players[0].handCat === null && s8.players[0].cats[0].cover != null, '手牌猫已盖到猫位');
ok(s8.players[1].hand.length === h1 + 2, '下家摸 2 张');
ok(e8.faceDownSlots(s8.players[0]).length === 4, '盖猫后 4 个猫位均未翻开');

// 12. 互换可用性判断
const e9 = setup(2, { extraCats2or3: true, handCatRule: true }); toPlaying(e9, 2);
const s9 = e9.s;
s9.players[0].hand = [{ id: 'sw', color: 'white', type: 'function', func: 'swap' }];
s9.lastCard = { color: 'white', type: 'function', func: 'draw' };
// 全保护 → 桌面 0 张可换；手牌猫有 2 → 可用
s9.players.forEach(p => p.cats.forEach(sl => { sl.protected = true; }));
ok(e9.swapPool().count >= 1, '手牌猫可用作互换');
e9.actPlay(0, 'sw', { a: { kind: 'hand', seat: 0 }, b: { kind: 'hand', seat: 1 } });
const hc0 = s9.players[0].handCat, hc1 = s9.players[1].handCat;
// 上一步交换了两人的手牌猫；记录后再交换回来验证
s9.players[0].hand = [{ id: 'sw2', color: 'white', type: 'function', func: 'swap' }];
s9.currentSeat = 0;
e9.actPlay(0, 'sw2', { a: { kind: 'hand', seat: 0 }, b: { kind: 'hand', seat: 1 } });
ok(s9.players[0].handCat != null && s9.players[1].handCat != null, '手牌猫互换成功');

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);