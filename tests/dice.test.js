// 被害連動ダイスのテスト（段階・確率分布・強化のタイミング）
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeConfig, HUMAN, MONSTER } from '../src/core/config.js';
import { DICE_STAGES, diceMaxes, stageOf, apDistribution, maxAP, meanAP } from '../src/core/dice.js';
import { createGame, beginTurn, applyAction, endTurn, rollDiceFor, diceMaxOf, diceStageOf } from '../src/core/rules.js';
import { makeRng } from '../src/core/rng.js';
import { board, unit } from './helpers.js';

/** 全組み合わせを数えた分布（実装とは独立） */
function brute(maxes) {
  const m = new Map();
  let total = 0;
  for (let a = 0; a <= maxes[0]; a++)
    for (let b = 0; b <= maxes[1]; b++)
      for (let c = 0; c <= maxes[2]; c++) {
        m.set(1 + a + b + c, (m.get(1 + a + b + c) || 0) + 1);
        total++;
      }
  return [...m.entries()].sort((x, y) => x[0] - y[0]).map(([ap, n]) => [ap, n / total]);
}

describe('段階と確率分布', () => {
  test('各段階のダイスの最大値（▲0 2・2・2 → ▲3 3・3・3、以降は固定）', () => {
    const expect = [[2, 2, 2], [3, 2, 2], [3, 3, 2], [3, 3, 3], [3, 3, 3], [3, 3, 3]];
    for (let lost = 0; lost <= 5; lost++) {
      assert.deepEqual(diceMaxes(lost), expect[lost]);
      assert.equal(stageOf(lost), Math.min(lost, 3));
    }
  });

  test('AP の範囲 1〜7 / 1〜8 / 1〜9 / 1〜10、分布が数え上げと一致、平均 4.0 / 4.5 / 5.0 / 5.5', () => {
    for (let lost = 0; lost <= 3; lost++) {
      const d = apDistribution(lost);
      assert.equal(d[0][0], 1);
      assert.equal(d[d.length - 1][0], 7 + lost);
      assert.equal(maxAP(lost), 7 + lost);
      const b = brute(DICE_STAGES[lost]);
      assert.equal(d.length, b.length);
      d.forEach(([ap, p], i) => {
        assert.equal(ap, b[i][0]);
        assert.ok(Math.abs(p - b[i][1]) < 1e-12);
      });
      assert.ok(Math.abs(meanAP(d) - (4 + lost / 2)) < 1e-12);
    }
  });

  test('ダイスの各面は等確率（▲3、各 0〜3）', () => {
    const s = createGame(makeConfig());
    s.lost = [3, 0];
    const rng = makeRng(42);
    const freq = [0, 0, 0, 0];
    for (let i = 0; i < 4000; i++) for (const v of rollDiceFor(s, rng)) freq[v]++;
    for (const f of freq) assert.ok(Math.abs(f / 12000 - 0.25) < 0.02, JSON.stringify(freq));
  });
});

describe('強化のタイミング', () => {
  const kill = (s, a, t) => applyAction(s, { type: 'attack', unit: unit(s.cfg, a), target: unit(s.cfg, t) }).state;

  test('リーダー以外を 1 体失うと ▲1、2 体で ▲2、3 体で ▲3。陣営ごとに独立', () => {
    let s = board({ 0: 'l.........', 4: '.WwAwM....', 5: '.....m....', 9: '.........L' }, { side: MONSTER, ap: 10, hp: { W: 1, A: 1, M: 1 } });
    s = kill(s, 'w', 'W');
    assert.equal(diceStageOf(s, HUMAN), 1);
    assert.deepEqual(diceMaxOf(s, HUMAN), [3, 2, 2]);
    s = kill(s, 'w2', 'A');
    assert.equal(diceStageOf(s, HUMAN), 2);
    s = kill(s, 'm', 'M');
    assert.equal(diceStageOf(s, HUMAN), 3);
    assert.deepEqual(diceMaxOf(s, HUMAN), [3, 3, 3]);
    assert.equal(diceStageOf(s, MONSTER), 0);
  });

  test('強化は次のダイスから。確定した AP は変わらない。範囲外の出目は受け付けない', () => {
    let s = board({ 0: 'l.........', 4: '....Ww....', 9: '.........L' }, { side: MONSTER, ap: 3, hp: { W: 1 } });
    s = kill(s, 'w', 'W');
    assert.equal(s.ap, 2);
    s = endTurn(s);
    assert.throws(() => beginTurn(s, [3, 3, 2]));
    const t = beginTurn(s, [3, 2, 2]);
    assert.equal(t.ap, 8);
    assert.deepEqual(t.diceMax, [3, 2, 2]);
    const fresh = createGame(makeConfig());
    assert.throws(() => beginTurn(fresh, [3, 0, 0]));
    assert.equal(beginTurn(fresh, [2, 2, 2]).ap, 7);
    assert.equal(beginTurn(fresh, [0, 0, 0]).ap, 1);
  });

  test('リーダーの撃破は即敗北で、喪失数に数えない', () => {
    let s = board({ 4: '....Lw....', 9: '..........' }, { side: MONSTER, ap: 2, hp: { L: 1 } });
    s = kill(s, 'w', 'L');
    assert.equal(s.winner, MONSTER);
    assert.equal(s.lost[HUMAN], 0);
  });
});
