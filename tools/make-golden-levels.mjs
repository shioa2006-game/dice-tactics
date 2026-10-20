// EASY・NORMAL の照合データを作る（HARD は tools/make-golden.mjs）。
// usage: node tools/make-golden-levels.mjs
//
// 同じ局面・同じ乱数・同じ性格を与えたときに選ぶ行動列を記録する。tests/levels.test.js は、levels.js を変えたあとも
// EASY・NORMAL がこれと 1 手も違わないことを確かめる。
//  - cases: HARD の照合データ（tests/fixtures/standard-golden.json）の 30 局面 × AP 1〜10
//  - game : その難易度どうしの対局（往復防止の prevStart も含めて、毎ターンの出目と行動列）
// ※ EASY・NORMAL の判断を意図して変えたとき以外は作り直さないこと。

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeConfig, HUMAN, MONSTER } from '../src/core/config.js';
import * as R from '../src/core/rules.js';
import { planLevel } from '../src/core/levels.js';
import { makeRng } from '../src/core/rng.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'tests', 'fixtures', 'levels-golden.json');
const cfg = makeConfig();
const STD = JSON.parse(readFileSync(join(root, 'tests', 'fixtures', 'standard-golden.json'), 'utf8'));

function unpack(p, ap) {
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

// 照合する組み合わせ（難易度・性格）
const PLAYERS = [
  { level: 'normal', persona: null },
  { level: 'easy', persona: 'rangedNovice' },
  { level: 'easy', persona: 'rushKnock' },
  { level: 'easy', persona: null },
];

const sets = [];
let timeCuts = 0;
for (const pl of PLAYERS) {
  const cases = STD.cases.map((c, i) => {
    const s = unpack(c.state, c.ap);
    const p = planLevel(s, { level: pl.level, persona: pl.persona, rng: makeRng(9000 + i) });
    if (p.info.timeCut) timeCuts++;
    return { idx: i, ap: c.ap, rngSeed: 9000 + i, actions: p.actions };
  });
  // その難易度どうしの対局（1 局）
  const seed = 303 + sets.length;
  const dice = makeRng(seed);
  const firstSide = sets.length % 2 ? MONSTER : HUMAN;
  let s = R.createGame(cfg, { firstSide });
  const prev = [null, null];
  const turns = [];
  let t = 0;
  while (s.phase !== 'over') {
    const d = R.rollDiceFor(s, dice);
    s = R.beginTurn(s, d);
    const p = planLevel(s, { level: pl.level, persona: pl.persona, rng: makeRng(seed * 1000 + t), prevStart: prev[s.side] });
    if (p.info.timeCut) timeCuts++;
    prev[s.side] = Array.from(s.pos);
    turns.push({ dice: d, actions: p.actions });
    for (const a of p.actions) s = R.applyAction(s, a).state;
    if (s.phase !== 'over') s = R.endTurn(s);
    t++;
  }
  sets.push({ ...pl, cases, game: { seed, firstSide, winner: s.winner, turns } });
}

if (timeCuts) {
  console.error(`時間切れ（timeCut）が ${timeCuts} 回起きました。負荷の低い状態で作り直してください。`);
  process.exit(1);
}
writeFileSync(out, JSON.stringify({ note: 'EASY・NORMAL の照合データ。tools/make-golden-levels.mjs で作成', sets }) + '\n');
console.log(sets.map((x) => `${x.level}/${x.persona}: cases ${x.cases.length}, game ${x.game.turns.length} ターン`).join('\n'), '\n→', out);
