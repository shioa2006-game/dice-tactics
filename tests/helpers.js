// テスト用のヘルパー（ゲーム本体は使わない）
//   board(): テキスト図から局面を作る。L W A M = 人間族の リーダー/戦士/弓使い/魔法使い、l w a m = モンスター族、# = 岩
//   同じ職業が 2 体いる場合は、図を上から読んだ順に 1 体目・2 体目。図にないユニットは撃破済み扱い（喪失数は opts.lost）
//   canKillLeader(): ルールの公開 API だけを使った全探索（CPU のコードは使わない）
import assert from 'node:assert/strict';
import { makeConfig, ROSTER, LEADER, WARRIOR, ARCHER, MAGE } from '../src/core/config.js';
import { createGame, applyAction, validateAction, legalActions, cloneState } from '../src/core/rules.js';
import { planTurn } from '../src/core/ai.js';
import { makeRng } from '../src/core/rng.js';

const LETTERS = { L: LEADER, W: WARRIOR, A: ARCHER, M: MAGE };

/**
 * @param {Object<number,string>} lines { 行番号(y): '..w..L....', ... }（省略した行は空き）
 * @param {object} opts { side, ap, hp: {L: 2, w2: 1}, lost: [人間族, モンスター族], turn }
 */
export function board(lines, opts = {}) {
  const rows = Array.from({ length: 10 }, (_, y) => lines[y] || '..........');
  const rocks = [];
  const start = [ROSTER.map(() => null), ROSTER.map(() => null)];
  rows.forEach((row, y) => {
    assert.equal(row.length, 10, `row ${y}`);
    [...row].forEach((ch, x) => {
      if (ch === '.') return;
      if (ch === '#') return rocks.push([x, y]);
      const up = ch.toUpperCase();
      const side = ch === up ? 0 : 1;
      const k = ROSTER.findIndex((t, i) => t === LETTERS[up] && !start[side][i]);
      if (k < 0) throw new Error('too many ' + ch);
      start[side][k] = [x, y];
    });
  });
  const cfg = makeConfig({ rocks, start });
  const s = createGame(cfg, { firstSide: opts.side ?? 0 });
  s.phase = 'act';
  s.ap = opts.ap ?? 5;
  s.apGained = s.ap;
  s.turn = opts.turn ?? 1;
  if (opts.lost) s.lost = opts.lost.slice();
  for (const [sym, hp] of Object.entries(opts.hp || {})) s.hp[unit(cfg, sym)] = hp;
  return s;
}

/** 'W' = 人間族の戦士（1 体目）、'w2' = モンスター族の戦士 2 体目 */
export function unit(cfg, sym) {
  const up = sym[0].toUpperCase();
  const side = sym[0] === up ? 0 : 1;
  const nth = sym.length > 1 ? +sym.slice(1) : 1;
  let n = 0;
  for (let k = 0; k < ROSTER.length; k++) if (ROSTER[k] === LETTERS[up] && ++n === nth) return side * ROSTER.length + k;
  throw new Error('no unit ' + sym);
}

/** CPU の計画を、合法性を確かめながら適用する */
export function runPlan(s, opts = {}) {
  const plan = planTurn(s, { rng: makeRng(1), ...opts });
  let st = s;
  for (const a of plan.actions) {
    assert.equal(validateAction(st, a), null, `CPU chose illegal action ${JSON.stringify(a)}`);
    st = applyAction(st, a).state;
  }
  return { plan, state: st };
}

/** attacker 陣営が AP=ap で相手のリーダーを倒せるか（全探索） */
export function canKillLeader(state, attacker, ap) {
  const s0 = cloneState(state);
  s0.side = attacker;
  s0.flags.fill(0);
  s0.phase = 'act';
  s0.ap = ap;
  s0.winner = null;
  const stack = [s0];
  const seen = new Set();
  while (stack.length) {
    const s = stack.pop();
    const key = s.pos.join(',') + s.hp.join(',') + s.flags.join(',') + s.ap;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const a of legalActions(s)) {
      if (a.type === 'end') continue;
      const n = applyAction(s, a).state;
      if (n.winner === attacker) return true;
      stack.push(n);
    }
  }
  return false;
}

export function minKillAP(state, attacker) {
  for (let ap = 1; ap <= 10; ap++) if (canKillLeader(state, attacker, ap)) return ap;
  return Infinity;
}
