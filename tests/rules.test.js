// ルールのテスト（盤面・移動・攻撃・押し出し・勝敗）
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeConfig, HUMAN, MONSTER, MOVED, ATTACKED } from '../src/core/config.js';
import { createGame, beginTurn, applyAction, validateAction, endTurn, rollDiceFor, legalActions, moveOptions, attackOptions, cellName } from '../src/core/rules.js';
import { makeRng } from '../src/core/rng.js';
import { board, unit } from './helpers.js';

const cfg = makeConfig();

describe('盤面と初期配置', () => {
  test('10×10・各陣営 6 体（王 1・戦 2・弓 2・魔 1）・岩 4', () => {
    assert.equal(cfg.W, 10);
    assert.equal(cfg.H, 10);
    assert.equal(cfg.unitCount, 12);
    for (const side of [0, 1]) assert.deepEqual(cfg.sideUnits[side].map((u) => cfg.unitType[u]), [0, 1, 1, 2, 2, 3]);
    assert.equal(cfg.obstacle.reduce((a, b) => a + b, 0), 4);
  });

  test('全ユニットが別々の空きマスにいて、配置と岩が点対称', () => {
    const s = createGame(cfg);
    const cells = new Set();
    for (let u = 0; u < cfg.unitCount; u++) {
      assert.ok(s.pos[u] >= 0 && !cfg.obstacle[s.pos[u]]);
      cells.add(s.pos[u]);
    }
    assert.equal(cells.size, cfg.unitCount);
    for (let k = 0; k < 6; k++) assert.equal(s.pos[k], 99 - s.pos[6 + k]);
    for (let c = 0; c < 100; c++) assert.equal(cfg.obstacle[c], cfg.obstacle[99 - c]);
  });

  test('座標名は A〜J・1〜10（下端が 1）', () => {
    assert.equal(cellName(0, cfg), 'A10');
    assert.equal(cellName(99, cfg), 'J1');
  });
});

describe('移動', () => {
  test('上下左右に AP の数だけ。岩とユニットは通れない', () => {
    const s = board({ 4: '....W#....', 5: '....w.....', 9: 'L........l' }, { ap: 2 });
    const opts = moveOptions(s, unit(s.cfg, 'W'));
    const cells = opts.map((o) => o.cell);
    assert.ok(!cells.includes(45)); // 岩
    assert.ok(!cells.includes(54)); // ユニット
    assert.ok(opts.every((o) => o.cost <= 2));
    assert.ok(cells.includes(24)); // 2 マス上
  });

  test('移動は 1 回、攻撃の後は移動できない、移動の後は攻撃できる', () => {
    let s = board({ 4: '....W.....', 6: '....w.....', 9: 'L........l' }, { ap: 5 });
    const W = unit(s.cfg, 'W');
    s = applyAction(s, { type: 'move', unit: W, to: 54 }).state;
    assert.equal(s.flags[W], MOVED);
    assert.match(validateAction(s, { type: 'move', unit: W, to: 53 }), /既に移動/);
    s = applyAction(s, { type: 'attack', unit: W, target: unit(s.cfg, 'w') }).state;
    assert.equal(s.flags[W], MOVED | ATTACKED);
    assert.equal(s.ap, 3);
  });
});

describe('攻撃', () => {
  test('弓: 射程 2〜4、隣接は撃てない', () => {
    const s = board({ 2: '..a.......', 4: '..A.......', 5: '..w.......', 9: 'L........l' }, { ap: 5 });
    const A = unit(s.cfg, 'A');
    const t = attackOptions(s, A).map((o) => o.target);
    assert.ok(t.includes(unit(s.cfg, 'a'))); // 距離 2
    assert.ok(!t.includes(unit(s.cfg, 'w'))); // 隣接
  });

  test('弓の押し出し: 空きマスへ 1 マス、盤の端・岩・ユニットでは押し出せない', () => {
    let s = board({ 4: '.A..w.....', 9: 'L........l' }, { ap: 5 });
    let r = applyAction(s, { type: 'attack', unit: unit(s.cfg, 'A'), target: unit(s.cfg, 'w') });
    assert.ok(r.events.some((e) => e.type === 'knockback' && e.to === 45));
    s = board({ 4: '......A..w', 9: 'L........l' }, { ap: 5 });
    r = applyAction(s, { type: 'attack', unit: unit(s.cfg, 'A'), target: unit(s.cfg, 'w') });
    assert.ok(r.events.some((e) => e.type === 'knockbackBlocked' && e.reason === 'edge'));
    s = board({ 4: '.A..w#....', 9: 'L........l' }, { ap: 5 });
    r = applyAction(s, { type: 'attack', unit: unit(s.cfg, 'A'), target: unit(s.cfg, 'w') });
    assert.ok(r.events.some((e) => e.type === 'knockbackBlocked' && e.reason === 'obstacle'));
  });

  test('魔法使い: 岩は越えられるが、ユニットは越えられない', () => {
    let s = board({ 3: '....w.....', 4: '....#.....', 5: '....M.....', 9: 'L........l' }, { ap: 5 });
    const opt = attackOptions(s, unit(s.cfg, 'M'));
    assert.equal(opt.length, 1);
    assert.equal(opt[0].overObstacle, true);
    s = board({ 3: '....w.....', 4: '....W.....', 5: '....M.....', 9: 'L........l' }, { ap: 5 });
    assert.ok(!attackOptions(s, unit(s.cfg, 'M')).some((o) => o.target === unit(s.cfg, 'w')));
  });

  test('リーダーを倒すと勝利、40 ラウンドで引き分け、AP は持ち越さない', () => {
    let s = board({ 4: '....Ll....', 9: '..........' }, { ap: 3, hp: { l: 1 } });
    s = applyAction(s, { type: 'attack', unit: unit(s.cfg, 'L'), target: unit(s.cfg, 'l') }).state;
    assert.equal(s.phase, 'over');
    assert.equal(s.winner, HUMAN);
    let g = board({ 0: 'l.........', 9: 'L.........' }, { ap: 4, turn: 80, side: MONSTER });
    g = endTurn(g);
    assert.equal(g.winner, 'draw');
    let h = board({ 0: 'l.........', 9: 'L.........' }, { ap: 4, turn: 3 });
    h = endTurn(h);
    assert.equal(h.ap, 0);
    assert.equal(h.side, MONSTER);
  });
});

test('ランダムな対局で、legalActions の全手が合法で例外が出ない', () => {
  const rng = makeRng(3);
  let s = createGame(cfg, { firstSide: HUMAN });
  for (let i = 0; i < 300 && s.phase !== 'over'; i++) {
    s = beginTurn(s, rollDiceFor(s, rng));
    for (let k = 0; k < 8 && s.phase === 'act'; k++) {
      const acts = legalActions(s);
      for (const a of acts) assert.equal(validateAction(s, a), null);
      const a = acts[Math.floor(rng() * acts.length)];
      if (a.type === 'end') break;
      s = applyAction(s, a).state;
    }
    if (s.phase === 'act') s = endTurn(s);
  }
});
