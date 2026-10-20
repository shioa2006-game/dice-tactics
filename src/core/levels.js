// DICE TACTICS 基本形 — CPU の難易度（表示名 ROOKIE・EASY・NORMAL・HARD。キーは rookie・easy・normal・hard）
//
//   ROOKIE    はじめての対局向け。ほかの難易度と違い、ターン全体の手順を読まない（planRookie）。
//             1 体ずつ「いま見えている一番よさそうな行動」を選ぶので、目の前の攻撃や弱った駒への追撃はするが、
//             複数の駒を組み合わせた連携や、遠くから回り込んでリーダーを狙う手はほとんど指さない。
//             相手の弓は 3 マスまで・魔法は岩を越えないと思っていて、リーダー以外の駒は大きな出目への備えも甘い。
//             前へ出たがる（寄せる重みが標準の 2 倍）。駒が残り少ない相手には、多少の反撃は気にせず敵リーダーへ寄せる
//   やさしい  （EASY）基本操作を覚えた人向け。ふつうを土台に、1 局ごとに「初心者らしい思い違い」を 1 つ持つ（性格。対局の開始時に決める）
//               飛び道具に不慣れ: 弓の射程は 3 マス、弓の押し出しはない、魔法は岩を越えない、と思っている
//               王さま一直線    : 敵リーダーを狙える位置へまっすぐ寄せる。弓の押し出しを忘れている
//             思い違いは「実ルールよりできることが少ない」ものだけなので、指す手は必ず合法（押し出しの食い違いは指し直す）
//   ふつう    （NORMAL）これまでの CPU と同じ読みを土台に、大きな出目への備えを甘くし、読む量を減らし、
//             ほぼ同じ評価の手からときどき 2 番手以下を選ぶ（これまでの CPU に対して約 2 割の強さ）
//   むずかしい （HARD）これまでの CPU（標準）そのもの。1 手も変えない（tests/levels.test.js の照合で確かめる）
//
// どの難易度も、ルールとダイスは同じ。CPU は未来の出目を見ない。違うのは考え方だけ。
// EASY・NORMAL・HARD は、勝てる手順があれば必ず指し、想定内の出目でリーダーを無防備にさらさず、駒を行ったり来たりさせない（安全柵）。
// やさしいの安全柵は実ルールで確かめる: 実ルールで見えている勝ちは取り、中央値以下の出目でリーダーを取られる形なら思い違いをやめる。

import { CPU, planTurn, replySearch, makeCtx, enumerateTurn, beamTurn, actionsOf, WIN_SCORE, attackCostMatrix, cappedDist, material, positional, valueTable, aggroFactor } from './ai.js';
import { LEADER, ARCHER, MAGE, DIRS, ATTACKED } from './config.js';
import { cloneState, validateAction, applyAction, occupancy, reachable, attackTargetsFrom, canMove, roundOf } from './rules.js';
import { apDistribution } from './dice.js';

// 読む量を減らす（5AP の全列挙をやめ、反撃の読みを狭くする）
const LIGHT = { exactMaxAP: 4, topK: 8, topSafe: 3, topGain: 3, replyBeam: { eval: 4, flee: 1, expand: 2 }, replyNodeCap: 40 };

const NORMAL = {
  ...CPU,
  ...LIGHT,
  name: 'ふつう',
  oppApQuantile: 0.5, // 相手の AP を中央値で頭打ちにして読む（▲0・▲1 は 4AP、▲2・▲3 は 5AP）
  pickTemp: 2, // 最善手から 4 点以内の候補を、差が小さいほど選ばれやすく選ぶ（戦士 1 体 ≈ 16 点）
  pickMaxDrop: 4,
  pickSafe: true,
};

// やさしいの性格（1 局に 1 つ）。params = 評価の重みの上書き、types = 職業の性質の思い違い（できることが少なくなる向きだけ）
const RUSH = { approach: [0, 0.4, 0.3, 0.3], engage: [0, 0.05, 0.03, 0.03] };
export const PERSONAS = {
  rangedNovice: {
    name: '飛び道具に不慣れ',
    hint: 'この CPU は「弓は 3 マスまで・押し出しなし・魔法は岩を越えない」と思い込んでいたようです',
    types: { [MAGE]: { obstacleBlocks: true }, [ARCHER]: { maxRange: 3, knockback: false } },
  },
  rushKnock: {
    name: '王さま一直線',
    hint: 'この CPU は王さまへ一直線で、弓の押し出しを忘れていたようです',
    params: RUSH,
    types: { [ARCHER]: { knockback: false } },
  },
};

const EASY = {
  ...NORMAL,
  name: 'やさしい',
  pickTemp: 3,
  pickMaxDrop: 8,
  personas: { rangedNovice: 1, rushKnock: 1 }, // 性格の重み（pickPersona）
};

// ROOKIE（はじめての対局向け）。ターン全体の手順を読まない別の考え方で指す（planRookie）
const ROOKIE = {
  name: 'ROOKIE',
  planner: 'rookie',
  params: { ...CPU.params, approach: [0, 0.2, 0.15, 0.15], engage: [0, 0.3, 0.2, 0.2] }, // 前へ出たがる（寄せる重みが標準の 2 倍）
  vision: 3, // 移動してから攻撃する手は、移動 3 マスまでしか考えない（遠くから回り込む攻撃は見落とす）
  wDanger: 0.8, // 相手の次のターンに受けそうな損害の重み
  leaderDanger: 150, // 自分のリーダーが倒されそうな形の重さ
  minGain: 0.1, // これより得にならない行動はしない（意味のない移動をしない）
  noise: 0.6, // 評価のばらつき（同じくらいの手から気まぐれに選ぶ）
  backtrack: 3, // 駒を前のターンの位置へ戻す行動の減点（往復を防ぐ）
  huntApproach: 4, // 追い込み（相手の駒が残り少ない）ときの、敵リーダーへ寄せる重みの倍率
  huntUnitDanger: 0.4, // 追い込みのときの、リーダー以外の駒の危険の重み
  perceive: { [MAGE]: { obstacleBlocks: true }, [ARCHER]: { maxRange: 3 } }, // 相手の弓・魔法が届く範囲の見積もりが甘い
};

/** 難易度の一覧（表示順）。hard はこれまでの CPU オブジェクトそのもの */
export const LEVELS = {
  rookie: ROOKIE,
  easy: EASY,
  normal: NORMAL,
  hard: CPU,
};

/** 画面に出す名前と説明 */
export const LEVEL_INFO = {
  rookie: { name: 'ROOKIE', stars: 1, desc: 'はじめての対局に。基本的な移動・攻撃を覚えながら、勝利を目指そう' },
  easy: { name: 'EASY', stars: 2, desc: '基本操作を覚えた方に。弓の射程や押し出しを勘違いしたり、王さまへ一直線に攻めたりする CPU' },
  normal: { name: 'NORMAL', stars: 3, desc: '大きな出目への備えが甘く、ときどき次善の手を選ぶ CPU。ルールを覚えたら挑戦' },
  hard: { name: 'HARD', stars: 4, desc: 'これまでの CPU。手ごわいけれど、読み勝てる相手' },
};

/** はじめて遊ぶ人（保存された設定がない）の難易度 */
export const DEFAULT_LEVEL = 'rookie';

/** 難易度のキーから CPU の設定を引く（知らないキーはむずかしい = これまでの CPU） */
export const cpuFor = (level) => LEVELS[level] || CPU;

/** 新しい対局の開始時に 1 回だけ呼ぶ。性格のキー（性格を持たない難易度は null）。UI は対局中これを保持して planLevel に渡す */
export function pickPersona(level, rng = Math.random) {
  const ps = cpuFor(level).personas;
  if (!ps) return null;
  const keys = Object.keys(ps);
  let r = rng() * keys.reduce((a, k) => a + ps[k], 0);
  for (const k of keys) if ((r -= ps[k]) <= 0) return k;
  return keys[keys.length - 1];
}

// 思い違いの盤面設定: 職業の性質の一部を変え、CPU の距離表（atkDist）だけ作り直す（config.js の staticAttackSpots と同じ考え方）
function attackSpots(T, target, cfg) {
  const out = [];
  const tx = target % cfg.W;
  const ty = (target / cfg.W) | 0;
  for (const [dx, dy] of DIRS) {
    for (let k = 1, x = tx, y = ty; k <= T.maxRange; k++) {
      x += dx;
      y += dy;
      if (x < 0 || y < 0 || x >= cfg.W || y >= cfg.H) break;
      const c = y * cfg.W + x;
      if (cfg.obstacle[c]) {
        if (T.obstacleBlocks) break;
        continue;
      }
      if (k >= T.minRange) out.push(c);
    }
  }
  return out;
}
const perceivedCache = new WeakMap();
function perceivedCfg(cfg, key, typeOv) {
  let m = perceivedCache.get(cfg);
  if (!m) perceivedCache.set(cfg, (m = new Map()));
  if (m.has(key)) return m.get(key);
  const N = cfg.CELLS;
  const types = cfg.types.map((t, i) => (typeOv[i] ? { ...t, ...typeOv[i] } : t));
  const atkDist = cfg.atkDist.slice();
  for (const k of Object.keys(typeOv)) {
    const t = +k;
    const table = new Int8Array(N * N).fill(99);
    for (let target = 0; target < N; target++) {
      if (cfg.obstacle[target]) continue;
      const spots = attackSpots(types[t], target, cfg);
      for (let from = 0; from < N; from++) {
        if (cfg.obstacle[from]) continue;
        let best = 99;
        for (const p of spots) {
          const d = cfg.sdist[from * N + p];
          if (d >= 0 && d < best) best = d;
        }
        table[from * N + target] = best;
      }
    }
    atkDist[t] = table;
  }
  const pc = { ...cfg, types, atkDist };
  m.set(key, pc);
  return pc;
}

/** 性格つきの計画（やさしい）。cpu = EASY、key = 性格のキー */
function planPersona(state, cpu, key, opts) {
  const ps = PERSONAS[key];
  const pcpu = ps.params ? { ...cpu, params: { ...cpu.params, ...ps.params } } : cpu;
  const plain = () => planTurn(state, { cpu, rng: opts.rng, prevStart: opts.prevStart });
  if (!ps.types) return planTurn(state, { cpu: pcpu, rng: opts.rng, prevStart: opts.prevStart });
  const pc = perceivedCfg(state.cfg, key, ps.types);
  // 安全柵 1: 思い違いをしている職業が、実ルールなら AP 内で敵リーダーを狙える（届く距離が思い違いより短い、
  // または押し出しを忘れている）ときは、実ルールで勝ち手順を探し、あれば指す（Stage1 の探索だけ。乱数は使わない）
  const cfg = state.cfg;
  const N = cfg.CELLS;
  const elp = state.pos[cfg.leaderOf[state.side ^ 1]];
  for (const u of cfg.sideUnits[state.side]) {
    const t = cfg.unitType[u];
    const ov = ps.types[t];
    if (!ov || state.pos[u] < 0 || elp < 0) continue;
    const i = state.pos[u] * N + elp;
    const dr = cfg.atkDist[t][i];
    if (dr + cfg.types[t].attackCost <= state.ap && (dr < pc.atkDist[t][i] || ov.knockback === false)) {
      const t0 = performance.now();
      const w = state.ap > cpu.exactMaxAP ? beamTurn(state, makeCtx(state, cpu), { deadline: t0 + 0.4 * cpu.timeLimitMs }).win : enumerateTurn(state).win;
      if (w) return { actions: actionsOf(w), info: { ap: state.ap, reason: 'win', realWin: true, persona: key } };
      break;
    }
  }
  // 思い違いの盤面で計画し、実ルールで 1 手ずつ確かめる（押し出しで食い違ったら、その時点から読み直す。最大 4 回）
  const perceive = (s) => {
    const t = cloneState(s);
    t.cfg = pc;
    return t;
  };
  let s = state;
  const actions = [];
  let r = planTurn(perceive(s), { cpu: pcpu, rng: opts.rng, prevStart: opts.prevStart });
  for (let iter = 0; iter < 4; iter++) {
    let bad = false;
    for (const a of r.actions) {
      if (validateAction(s, a)) {
        bad = true;
        break;
      }
      s = applyAction(s, a).state;
      actions.push(a);
      if (s.phase === 'over') break;
    }
    if (!bad || s.phase === 'over') break;
    r = planTurn(perceive(s), { cpu: pcpu, rng: opts.rng, prevStart: opts.prevStart });
  }
  // 安全柵 2: 実ルールで、相手が中央値以下の AP でリーダーを倒せる形なら、思い違いをやめて（性格なしで）指し直す
  if (s.phase !== 'over') {
    const ctx = makeCtx(state, { ...cpu, replyBeam: CPU.replyBeam, replyNodeCap: CPU.replyNodeCap });
    const v = replySearch(s, state.side, ctx).value;
    if (v[v.length - 1] <= -WIN_SCORE / 2) {
      const g = plain();
      g.info = { ...g.info, persona: key, guard: true };
      return g;
    }
  }
  return { actions, info: { ...r.info, persona: key } };
}

// ---------------------------------------------------------------------------
// ROOKIE: ターン全体の手順は読まず、1 体ずつ「いま見えている一番よさそうな行動」を選んでいく
// ---------------------------------------------------------------------------

const DG_OCC = new Int8Array(256);
const DG_COST = new Int8Array(64);

/**
 * ROOKIE の見積もる「相手の次のターンに受ける損害」。弓は 3 マスまで、魔法は岩を越えないと思っている。
 * リーダー以外は相手の AP を中央値と思って数える（大きな出目への備えが甘い）。相手の駒どうしの兼ね合いは考えない
 */
function rookieDanger(s, me, ctx, cpu) {
  const cfg = s.cfg;
  const NP = cfg.perSide;
  const A = ctx.oppAP;
  const costs = attackCostMatrix({ cfg: ctx.pc, pos: s.pos, hp: s.hp }, me ^ 1, occupancy(s, DG_OCC), ctx.oppMax, DG_COST);
  const mine = cfg.sideUnits[me];
  let sum = 0;
  let max = 0;
  for (let j = 0; j < NP; j++) {
    const u = mine[j];
    if (s.pos[u] < 0) continue;
    // 安い攻撃から順に、AP の範囲で何回殴られるか（相手の駒どうしの兼ね合いは考えない）
    const t = cfg.unitType[u];
    const hp = s.hp[u];
    const cs = [];
    for (let i = 0; i < NP; i++) if (costs[i * NP + j] <= ctx.oppMax) cs.push(costs[i * NP + j]);
    if (!cs.length) continue;
    cs.sort((a, b) => a - b);
    const VAL = ctx.VAL[t];
    // AP が a のときに殴られる回数（安い攻撃から順に）での損害
    const lossAt = (a) => {
      let k = 0;
      for (let i = 0, spent = 0; i < cs.length && spent + cs[i] <= a; i++, k++) spent += cs[i];
      if (k >= hp) return t === LEADER ? cpu.leaderDanger : VAL[hp];
      return VAL[hp] - VAL[hp - k];
    };
    let loss = 0;
    if (t === LEADER) {
      // リーダーだけは大きな出目も考える（出目の分布での期待値）
      for (const [a, p] of ctx.oppDist) loss += p * lossAt(a);
    } else loss = ctx.unitDanger * lossAt(A);
    sum += loss;
    if (loss > max) max = loss;
  }
  return max + 0.3 * (sum - max);
}

function rookieEval(s, me, ctx, cpu) {
  if (s.winner === me) return WIN_SCORE * 10;
  const { VAL, aggro } = ctx;
  // 位置は自分の駒の分だけ見る（相手の駒の配置の良し悪しまでは考えない）
  return material(s, me, VAL) - material(s, me ^ 1, VAL) + positional(s, me, ctx.myP, aggro) - cpu.wDanger * rookieDanger(s, me, ctx, cpu);
}

/** ユニット u の 1 体分の行動案（攻撃だけ・移動だけ・近くへ移動して攻撃） */
function unitPlans(s, u, cpu) {
  const cfg = s.cfg;
  const T = cfg.types[cfg.unitType[u]];
  const occ = occupancy(s);
  const out = [];
  const canHit = (s.flags[u] & ATTACKED) === 0 && s.ap >= T.attackCost;
  if (canHit) for (const x of attackTargetsFrom(s, u, s.pos[u], occ)) out.push([{ type: 'attack', unit: u, target: x.target }]);
  if (!canMove(s, u)) return out;
  const { dist } = reachable(s, u, s.ap);
  const mc = cfg.rules.moveCost;
  for (let c = 0; c < cfg.CELLS; c++) {
    const d = dist[c];
    if (d <= 0) continue;
    const mv = { type: 'move', unit: u, to: c };
    out.push([mv]);
    if (canHit && d <= cpu.vision && s.ap - d * mc >= T.attackCost) {
      for (const x of attackTargetsFrom(s, u, c, occ)) out.push([mv, { type: 'attack', unit: u, target: x.target }]);
    }
  }
  return out;
}

/** ROOKIE の計画。行動はすべて applyAction（実ルール）で 1 つずつ適用して確かめる */
function planRookie(state, cpu, { rng = Math.random, prevStart } = {}) {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const cfg = state.cfg;
  const me = state.side;
  const P = cpu.params;
  const dist = apDistribution(state.lost[me ^ 1]);
  const ctx = {
    VAL: valueTable(cfg, P),
    aggro: aggroFactor(P, roundOf(state)),
    pc: perceivedCfg(cfg, 'rookie', cpu.perceive),
    oppAP: cappedDist(dist, 0.5).max, // リーダー以外の駒の危険は、相手の AP を中央値と思って見積もる
    oppMax: dist[dist.length - 1][0],
    oppDist: dist,
  };
  // 追い込み: 相手の駒（リーダー以外）が 1 体以下か、こちらが 2 体以上多いときは、多少の反撃は気にせず敵リーダーへ寄せる
  const army = (side) => cfg.sideUnits[side].filter((u) => u !== cfg.leaderOf[side] && state.pos[u] >= 0).length;
  const hunt = army(me ^ 1) <= 1 || army(me) - army(me ^ 1) >= 2;
  ctx.myP = hunt ? { ...P, approach: P.approach.map((x) => x * cpu.huntApproach) } : P;
  ctx.unitDanger = hunt ? cpu.huntUnitDanger : 1;
  let s = state;
  const actions = [];
  let cur = rookieEval(s, me, ctx, cpu);
  for (let step = 0; step < 24 && s.phase === 'act' && s.ap > 0; step++) {
    let best = null;
    for (const u of cfg.sideUnits[me]) {
      if (s.pos[u] < 0) continue;
      for (const plan of unitPlans(s, u, cpu)) {
        let t = s;
        for (const a of plan) t = applyAction(t, a).state;
        let v = rookieEval(t, me, ctx, cpu);
        const back = prevStart && plan[0].type === 'move' && plan[0].to === prevStart[u] && state.pos[u] !== prevStart[u];
        if (back) v -= cpu.backtrack;
        if (v - cur <= cpu.minGain) continue;
        const nv = v + (rng() - 0.5) * cpu.noise;
        if (!best || nv > best.nv) best = { nv, plan, t };
      }
    }
    if (!best) break;
    actions.push(...best.plan);
    s = best.t;
    cur = rookieEval(s, me, ctx, cpu);
  }
  const ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  return { actions, info: { ap: state.ap, planner: 'rookie', ms, ...(s.winner === me ? { reason: 'win' } : {}) } };
}

/**
 * 難易度つきで行動計画を立てる。
 * @param {object} state 手番の陣営の局面（phase = 'act'）
 * @param {{level?: string, rng?: () => number, prevStart?: number[], persona?: string|null}} opts
 *   prevStart = 前のターンの開始時の駒の位置、persona = pickPersona() で対局の開始時に決めた性格のキー（性格を持つ難易度だけが使う）
 */
export function planLevel(state, { level, rng, prevStart, persona } = {}) {
  const cpu = cpuFor(level);
  if (cpu.planner === 'rookie') return planRookie(state, cpu, { rng, prevStart });
  if (cpu.personas && persona && PERSONAS[persona]) return planPersona(state, cpu, persona, { rng, prevStart });
  return planTurn(state, { cpu, rng, prevStart });
}
