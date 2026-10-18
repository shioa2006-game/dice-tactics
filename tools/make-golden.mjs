// 「むずかしい」（これまでの CPU 標準）の照合データを作る。
// usage: node tools/make-golden.mjs
//
// 固定したシードで CPU どうしの対局を指し、毎ターンの出目と行動列を記録する。さらに、その対局から取り出した局面で
// AP 1〜10 のときに CPU が選ぶ行動列も記録する。tests/levels.test.js は、ai.js を変えたあとも
// これまでの CPU がこれと 1 手も違わないことを確かめる。
// ※ 照合データは「これまでの CPU」の手そのもの。ai.js の標準の判断を意図して変えたとき以外は作り直さないこと。

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeConfig, HUMAN, MONSTER } from '../src/core/config.js';
import * as R from '../src/core/rules.js';
import { planTurn, CPU } from '../src/core/ai.js';
import { makeRng } from '../src/core/rng.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'tests', 'fixtures', 'standard-golden.json');
const cfg = makeConfig();

/** 局面を JSON にできる形にする（照合に必要な項目だけ） */
export function packState(s) {
  return { pos: Array.from(s.pos), hp: Array.from(s.hp), flags: Array.from(s.flags), side: s.side, firstSide: s.firstSide, turn: s.turn, lost: s.lost.slice(), ap: s.ap };
}

const games = [];
const positions = [];
const GAME_SEEDS = [101, 202];
let timeCuts = 0;
for (const [gi, seed] of GAME_SEEDS.entries()) {
  const dice = makeRng(seed);
  let s = R.createGame(cfg, { firstSide: gi % 2 ? MONSTER : HUMAN });
  const turns = [];
  let t = 0;
  while (s.phase !== 'over') {
    const d = R.rollDiceFor(s, dice);
    s = R.beginTurn(s, d);
    // 局面を取り出しておく（4 ターンごと）
    if (t % 4 === 1) positions.push({ game: gi, turn: t, state: packState(s) });
    const p = planTurn(s, { rng: makeRng(seed * 1000 + t) });
    if (p.info.timeCut) timeCuts++;
    turns.push({ dice: d, actions: p.actions });
    for (const a of p.actions) s = R.applyAction(s, a).state;
    if (s.phase !== 'over') s = R.endTurn(s);
    t++;
  }
  games.push({ seed, firstSide: gi % 2 ? MONSTER : HUMAN, winner: s.winner, turns });
}

// 取り出した局面から最大 40 局面を、AP 1〜10 に均等に割り当てて記録する
const picked = [];
const step = Math.max(1, Math.floor(positions.length / 40));
for (let i = 0; i < positions.length && picked.length < 40; i += step) picked.push(positions[i]);
const cases = picked.map((p, i) => {
  const ap = (i % 10) + 1;
  const s = unpack(p.state, ap);
  const plan = planTurn(s, { rng: makeRng(7000 + i) });
  if (plan.info.timeCut) timeCuts++;
  return { ...p, ap, rngSeed: 7000 + i, actions: plan.actions };
});

if (timeCuts) {
  console.error(`時間切れ（timeCut）が ${timeCuts} 回起きました。負荷の低い状態で作り直してください。`);
  process.exit(1);
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ note: 'これまでの CPU（標準 = むずかしい）の照合データ。tools/make-golden.mjs で作成', cpuKeys: Object.keys(CPU), games, cases }) + '\n');
console.log(`games: ${games.length}（${games.map((g) => g.turns.length).join(', ')} ターン）, cases: ${cases.length} → ${out}`);

export function unpack(p, ap = p.ap) {
  const s = R.createGame(cfg, { firstSide: p.firstSide });
  s.pos = Int8Array.from(p.pos);
  s.hp = Int8Array.from(p.hp);
  s.flags = Uint8Array.from(p.flags);
  s.side = p.side;
  s.turn = p.turn;
  s.lost = p.lost.slice();
  s.phase = 'act';
  s.ap = ap;
  s.apGained = ap;
  return s;
}
