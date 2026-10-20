// 難易度どうしの自己対局（対戦の強さと行動の指標を測る）
// usage: node tools/selfplay.mjs <難易度A> <難易度B> [組数=200] [開始シード=1] [並列数=CPU数-1]
//   例: node tools/selfplay.mjs rookie easy 300
//
// 1 組 = 同じダイスの乱数列で、陣営（と先手）を入れ替えて 2 局。A のスコア = 勝ち + 0.5 × 引き分け。
// 行動の指標（1 局・1 陣営あたり）:
//   攻撃 / 撃破        攻撃した回数・倒した駒の数
//   連携撃破            同じターンに 2 体以上で殴って倒した駒の数
//   遠征攻撃            4 マス以上移動してから攻撃した回数（うちリーダーへ）
//   連携の決着 / 遠征の決着  勝った手が「2 体以上での連携」「4 マス以上の移動から」だった割合
//   弓 4 マス目 / 岩越し魔法  相手のその攻撃を受けた回数（ROOKIE が見落としやすい攻撃）
//   往復                前のターンの位置へ戻った移動
//   見送り              AP 3 以上で何もしなかったターン
// 調整用: 環境変数 LEVEL_OVERRIDE='{"rookie":{"noise":1}}' で難易度の設定を一時的に上書きできる（params は丸ごと置き換え）

import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import { makeConfig, HUMAN, MONSTER, ARCHER, MAGE } from '../src/core/config.js';
import * as R from '../src/core/rules.js';
import { planLevel, pickPersona, LEVELS } from '../src/core/levels.js';
import { makeRng } from '../src/core/rng.js';

const KEYS = ['attacks', 'kills', 'comboKills', 'farAttacks', 'farLeaderAttacks', 'wins', 'comboWins', 'farWins', 'archer4Taken', 'mageRockTaken', 'backtracks', 'idleTurns', 'turns', 'lostUnits', 'ms'];

function playGame(levels, seed, firstSide) {
  const cfg = makeConfig();
  const dice = makeRng(seed);
  const persona = levels.map((lv, side) => pickPersona(lv, makeRng(seed * 7 + side)));
  let s = R.createGame(cfg, { firstSide });
  const st = [0, 1].map(() => Object.fromEntries(KEYS.map((k) => [k, 0])));
  const prev = [null, null];
  let t = 0;
  while (s.phase !== 'over') {
    s = R.beginTurn(s, R.rollDiceFor(s, dice));
    const side = s.side;
    const m = st[side];
    const p = planLevel(s, { level: levels[side], rng: makeRng(seed * 1000 + t), prevStart: prev[side], persona: persona[side] });
    m.ms += p.info.ms || 0;
    m.turns++;
    if (s.ap >= 3 && p.actions.length === 0) m.idleTurns++;
    const start = Array.from(s.pos);
    const moved = new Map(); // unit → 移動マス数
    const hitters = new Map(); // target → このターンに殴った駒の集合
    for (const a of p.actions) {
      if (a.type === 'move') {
        if (prev[side] && prev[side][a.unit] === a.to && start[a.unit] !== a.to) m.backtracks++;
      }
      const { state, events } = R.applyAction(s, a);
      for (const e of events) {
        if (e.type === 'move') moved.set(e.unit, e.cost / cfg.rules.moveCost);
        if (e.type === 'attack') {
          m.attacks++;
          const far = (moved.get(e.unit) || 0) >= 4;
          if (far) m.farAttacks++;
          if (far && cfg.unitType[e.target] === 0) m.farLeaderAttacks++;
          const tt = cfg.unitType[e.unit];
          if (tt === ARCHER && e.dist === 4) st[side ^ 1].archer4Taken++;
          if (tt === MAGE && e.overObstacle) st[side ^ 1].mageRockTaken++;
          if (!hitters.has(e.target)) hitters.set(e.target, new Set());
          hitters.get(e.target).add(e.unit);
        }
        if (e.type === 'kill') {
          m.kills++;
          const combo = hitters.get(e.unit).size >= 2;
          if (combo) m.comboKills++;
          if (cfg.unitType[e.unit] === 0) {
            m.wins++;
            if (combo) m.comboWins++;
            if ([...hitters.get(e.unit)].some((u) => (moved.get(u) || 0) >= 4)) m.farWins++;
          } else st[side ^ 1].lostUnits++;
        }
      }
      s = state;
    }
    prev[side] = start;
    if (s.phase !== 'over') s = R.endTurn(s);
    t++;
  }
  return { winner: s.winner, rounds: R.roundOf(s), st };
}

if (process.env.LEVEL_OVERRIDE) {
  for (const [lv, ov] of Object.entries(JSON.parse(process.env.LEVEL_OVERRIDE))) Object.assign(LEVELS[lv], ov);
}

if (!isMainThread) {
  const { a, b, seeds } = workerData;
  for (const seed of seeds) {
    const firstSide = seed % 2 ? HUMAN : MONSTER;
    // 1 局目: A = 人間族、2 局目: A = モンスター族（同じダイス列・同じ先手）
    const g1 = playGame([a, b], seed, firstSide);
    const g2 = playGame([b, a], seed, firstSide);
    parentPort.postMessage([
      { winnerA: g1.winner === 'draw' ? 'draw' : g1.winner === HUMAN, rounds: g1.rounds, A: g1.st[HUMAN], B: g1.st[MONSTER] },
      { winnerA: g2.winner === 'draw' ? 'draw' : g2.winner === MONSTER, rounds: g2.rounds, A: g2.st[MONSTER], B: g2.st[HUMAN] },
    ]);
  }
  parentPort.postMessage('done');
} else {
  const [a = 'rookie', b = 'easy', pairsArg = '200', startArg = '1', parArg] = process.argv.slice(2);
  for (const lv of [a, b]) if (!LEVELS[lv]) throw new Error(`知らない難易度: ${lv}`);
  const pairs = +pairsArg;
  const start = +startArg;
  const par = Math.max(1, Math.min(+(parArg || cpus().length - 1), pairs));
  const results = [];
  const t0 = Date.now();
  await Promise.all(
    Array.from({ length: par }, (_, w) => {
      const seeds = [];
      for (let i = w; i < pairs; i += par) seeds.push(start + i);
      return new Promise((res, rej) => {
        const wk = new Worker(fileURLToPath(import.meta.url), { workerData: { a, b, seeds } });
        wk.on('message', (m) => (m === 'done' ? res() : results.push(...m)));
        wk.on('error', rej);
      });
    }),
  );
  const n = results.length;
  const pts = results.map((r) => (r.winnerA === 'draw' ? 0.5 : r.winnerA ? 1 : 0));
  // 組ごとの得点の平均から標準誤差を出す（同じダイス列の 2 局は相関するため）
  const pairPts = [];
  for (let i = 0; i < n; i += 2) pairPts.push((pts[i] + pts[i + 1]) / 2);
  const mean = pts.reduce((x, y) => x + y, 0) / n;
  const sd = Math.sqrt(pairPts.reduce((x, y) => x + (y - mean) ** 2, 0) / (pairPts.length - 1 || 1));
  const se = sd / Math.sqrt(pairPts.length);
  const wins = results.filter((r) => r.winnerA === true).length;
  const draws = results.filter((r) => r.winnerA === 'draw').length;
  const avg = (side, k) => results.reduce((x, r) => x + r[side][k], 0) / n;
  console.log(`${a} 対 ${b}: ${n} 局（${pairs} 組）  ${a} のスコア ${(100 * mean).toFixed(1)}% ±${(100 * se).toFixed(1)}（勝 ${wins} / 分 ${draws} / 負 ${n - wins - draws}）`);
  console.log(`平均ラウンド ${(results.reduce((x, r) => x + r.rounds, 0) / n).toFixed(1)}、引き分け率 ${((100 * draws) / n).toFixed(1)}%、所要 ${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
  const rows = [
    ['攻撃', 'attacks'],
    ['撃破', 'kills'],
    ['連携撃破', 'comboKills'],
    ['遠征攻撃', 'farAttacks'],
    ['うちリーダーへ', 'farLeaderAttacks'],
    ['弓 4 マス目を受けた', 'archer4Taken'],
    ['岩越し魔法を受けた', 'mageRockTaken'],
    ['失った駒', 'lostUnits'],
    ['往復', 'backtracks'],
    ['見送り', 'idleTurns'],
    ['思考 ms / ターン', 'ms'],
  ];
  console.log(`${'指標（1 局あたり）'.padEnd(16)}${a.padStart(10)}${b.padStart(10)}`);
  for (const [label, k] of rows) {
    const f = k === 'ms' ? (side) => avg(side, 'ms') / Math.max(1, avg(side, 'turns')) : (side) => avg(side, k);
    console.log(`${label.padEnd(16)}${f('A').toFixed(2).padStart(10)}${f('B').toFixed(2).padStart(10)}`);
  }
  const winSplit = (side) => {
    const w = results.reduce((x, r) => x + r[side].wins, 0);
    const c = results.reduce((x, r) => x + r[side].comboWins, 0);
    const f = results.reduce((x, r) => x + r[side].farWins, 0);
    return w ? `勝ち ${w}（連携の決着 ${((100 * c) / w).toFixed(0)}%、遠征の決着 ${((100 * f) / w).toFixed(0)}%）` : '勝ち 0';
  };
  console.log(`${a}: ${winSplit('A')}`);
  console.log(`${b}: ${winSplit('B')}`);
}
