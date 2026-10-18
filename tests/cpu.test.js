// CPU（標準）のテスト
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeConfig, HUMAN, MONSTER } from '../src/core/config.js';
import { createGame, beginTurn, applyAction, endTurn, rollDiceFor, validateAction, cloneState } from '../src/core/rules.js';
import { planTurn, beamTurn, makeCtx, actionsOf, CPU } from '../src/core/ai.js';
import { makeRng } from '../src/core/rng.js';
import { board, unit, runPlan, canKillLeader, minKillAP } from './helpers.js';

const cfg = makeConfig();

/** CPU 同士で数ターン進めた局面を集める */
function positions(n, seed) {
  const out = [];
  const rng = makeRng(seed);
  let s = createGame(cfg, { firstSide: HUMAN });
  while (s.phase !== 'over' && out.length < n) {
    s = beginTurn(s, rollDiceFor(s, rng));
    if (s.turn % 4 === 3) out.push(cloneState(s));
    const p = planTurn(s, { rng });
    for (const a of p.actions) s = applyAction(s, a).state;
    if (s.phase !== 'over') s = endTurn(s);
  }
  return out;
}
const POS = positions(4, 11);

describe('合法性と予測の一致', () => {
  test('AP 1〜10 で合法なプランを返す（初期局面・実戦局面）', () => {
    for (const base of [createGame(cfg), ...POS]) {
      for (const ap of [1, 3, 5, 6, 8, 10]) {
        const s = cloneState(base);
        s.phase = 'act';
        s.ap = ap;
        s.apGained = ap;
        const { plan } = runPlan(s);
        assert.equal(plan.info.search, ap > CPU.exactMaxAP ? 'beam' : 'exact');
      }
    }
  });

  test('ビームサーチの終局面は、行動列をルールエンジンで適用した結果と一致する', () => {
    let n = 0;
    for (const base of POS) {
      const s = cloneState(base);
      s.ap = 9;
      const res = beamTurn(s, makeCtx(s, CPU));
      for (const node of res.terminals.slice(0, 200)) {
        let t = s;
        for (const a of actionsOf(node)) {
          assert.equal(validateAction(t, a), null);
          t = applyAction(t, a).state;
        }
        assert.deepEqual(Array.from(t.pos), Array.from(node.s.pos));
        assert.deepEqual(Array.from(t.hp), Array.from(node.s.hp));
        assert.equal(t.ap, node.s.ap);
        n++;
      }
    }
    assert.ok(n > 200);
  });

  test('探索を打ち切っても合法なプランを返す', () => {
    const tiny = { ...CPU, beamWidth: 1, maxGen: 3, timeLimitMs: 0, preEval: 1, preGain: 0, topK: 1, topSafe: 0, topGain: 0 };
    const s = createGame(cfg);
    s.phase = 'act';
    s.ap = 10;
    runPlan(s, { cpu: tiny });
  });
});

describe('戦術', () => {
  test('今ターンの勝ち筋を見つける', () => {
    const s = board({ 0: '........l.', 3: '..w..L....' }, { side: MONSTER, ap: 3, hp: { L: 1 } });
    assert.equal(runPlan(s).state.winner, MONSTER);
  });

  test('8AP でだけ成立する連携（戦士で削ってから弓でとどめ。先に弓だと押し出しで届かない）', () => {
    const s = board({ 0: '.........l', 2: '.....w....', 8: '..a..L....' }, { side: MONSTER, ap: 8, hp: { L: 2 } });
    assert.equal(canKillLeader(s, MONSTER, 8), true);
    assert.equal(canKillLeader(s, MONSTER, 7), false);
    assert.equal(runPlan(s).state.winner, MONSTER);
  });

  test('相手の 6AP でリーダーが倒される位置から退避する（相手 ▲0 は最大 7AP）', () => {
    const s = board({ 1: '.....l....', 7: '.....W....', 9: '.........L' }, { side: MONSTER, ap: 2, hp: { l: 1 } });
    assert.equal(minKillAP(s, HUMAN), 6);
    assert.ok(minKillAP(runPlan(s).state, HUMAN) > 7);
  });

  test('相手のダイスが強化されても（▲2 → ▲3）、安全で有利な撃破はする', () => {
    const s = board({ 0: 'l.........', 4: '....Ww....', 9: '.........L' }, { side: MONSTER, ap: 3, hp: { W: 1 }, lost: [2, 0] });
    assert.equal(runPlan(s).state.pos[unit(s.cfg, 'W')], -1);
  });
});
