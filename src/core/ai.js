// DICE TACTICS 基本形 — CPU（標準）
//
// 方式:
//   Stage 1  自ターンの行動列を探す。AP 5 以下は全列挙（同じ局面の重複を除く）。AP 6 以上は
//            「その場で攻撃／移動して攻撃／移動のみ」を 1 段とするビームサーチ。
//   事前選別 終局面を軽い評価で並べ、上位だけを本来の評価（fastEval）にかける。
//   Stage 2  上位の候補ごとに「相手の反撃」を探索する（相手が次に得る AP ごとに最も痛い反撃）。
//            相手の AP の確率分布は、その局面での相手の喪失数（被害連動ダイスの強化段階）から決める。
//   評価    素材（HP・ユニット価値）＋ 位置 ＋ 次ターンの攻撃可能性（双方）
//
// ルール判定はすべて rules.js の関数を使い、ゲーム本体と食い違わないようにしている。
// 未来のダイスの出目は使わない（確率分布だけを使う）。

import { LEADER, MOVED, ATTACKED, DIRS } from './config.js';
import { apDistribution, maxAP, stageOf } from './dice.js';
import { occupancy, bfsInto, attackTargetsFrom, mutMove, mutAttack, cloneState, roundOf } from './rules.js';

const INF = 99;
// 勝敗の評価値。素材価値（全ユニット満タンで約110点）と同程度のスケールにし、
// 「低確率の敗北リスク」が他の判断を過剰に支配しないようにする。
export const WIN_SCORE = 200;

// ---------------------------------------------------------------------------
// CPU の設定（標準）
// ---------------------------------------------------------------------------

const PARAMS = {
  // 素材価値
  leaderMarginal: [20, 17, 14, 11], // リーダーの HP1,2,3,4 の 1 点あたり価値（低 HP ほど重い）
  unitBase: [0, 7, 8, 8], // 生存価値（リーダーは別扱い）
  unitPerHp: [0, 3, 4, 4],
  // 脅威計算でのリーダー撃破の価値
  leaderKillDef: 200, // 自リーダーが撃破されうる（防御側の評価）
  leaderKillOff: 45, // 敵リーダーを次々ターン撃破しうる（相手が先に対処できるので控えめ）
  leaderKillLeaf: 170, // 反撃後の局面で、自分の次ターンに敵リーダーを撃破できる（ほぼ勝ち）
  // 位置評価
  approach: [0, 0.1, 0.075, 0.075], // 敵リーダーを攻撃できる位置への近さ
  engage: [0, 0.15, 0.1, 0.1], // 最寄りの敵を攻撃できる位置への近さ
  aggroPerRound: 0.025, // ラウンドが進むほど前進を重視（膠着防止）
  lateAggroStart: 25, // このラウンド以降は前進・追撃の重みをさらに強める（引き分け回避）
  lateAggroPerRound: 0.15,
  guard: 0.5, // 自リーダーに隣接する味方 1 体あたり（進路・射線の遮蔽）
  endgameLeaderApproach: 0.6, // 敵がリーダーのみで自リーダーの HP が同等以上なら、リーダーも追撃に加わる
  advance: [0, 0.6, 0.4, 0.4], // 前線の形成: 戦士・弓・魔法が自陣の端から前へ進んだ行数へのボーナス
  advanceCap: [0, 4, 2, 2], // その上限（行数）。戦士は中央の前線まで、弓・魔法はその 2 行後ろまで
  // 脅威（次ターンの攻撃可能性）の重み
  wDefFast: 0.85, // Stage1: 相手の次ターン攻撃（自ターン終了時）
  wOffFast: 0.3, // Stage1: 自分の次々ターン攻撃
  wOffLeaf: 0.7, // Stage2 葉: 自分の次ターン攻撃（自分の手番なので重め）
  wDefLeaf: 0.15, // Stage2 葉: 相手の次々ターン攻撃
  fleeCandidates: [3, 2, 2, 2], // 反撃探索で相手ユニットが「逃げる」移動先の候補数（職業別）
  actionPenalty: 0.01, // 同価値なら行動数の少ない（意図の明確な）プラン
};

/**
 * CPU（標準）の設定。planTurn(state, { cpu }) で上書きできる。難易度は src/core/levels.js（標準 = むずかしい）。
 * 難易度用に、標準にはない次の項目を使える（ない場合は何もしない）:
 *   oppApQuantile  相手の次ターンの AP をこの分位点で頭打ちにして読む（0.5 = 中央値。大きな出目への備えが甘くなる）
 *   pickTemp / pickMaxDrop / pickSafe  最善手の近くの候補から確率的に選ぶ（pickNearBest）
 */
export const CPU = {
  name: '標準',
  params: PARAMS,
  noise: 0.02, // 同程度の手からのばらつき
  exactMaxAP: 5, // これ以下の AP は全列挙
  beamWidth: 250, // Stage 1 ビームの幅（各段で展開する局面数）
  moveK: 8, // 移動のみの候補マス数（ユニットごと）
  atkCells: 3, // 移動して攻撃: 標的・方向ごとの攻撃位置の候補数（＋最も安いマス）
  maxGen: 60000, // Stage 1 ビームで生成する局面数の上限
  preEval: 600, // 本来の評価（fastEval）にかける終局面の数（軽い評価の上位）
  preGain: 40, // 同じく、素材の得が大きい順の上位
  topK: 18, // 反撃探索にかける候補: 総合評価の上位
  topSafe: 6, // 防御重視の上位
  topGain: 6, // 即時の戦果の上位
  replyBeam: { eval: 10, flee: 3, expand: 5 }, // 反撃探索のビーム
  replyNodeCap: 400, // 反撃探索のノード数の上限（候補 1 つあたり）
  timeLimitMs: 4000, // 安全装置（通常はノード数の上限で収まる）
};

// ---------------------------------------------------------------------------
// 素材・位置評価
// ---------------------------------------------------------------------------

const valueCache = new WeakMap();
function valueTable(cfg, P) {
  let byP = valueCache.get(cfg);
  if (!byP) valueCache.set(cfg, (byP = new Map()));
  let tbl = byP.get(P);
  if (tbl) return tbl;
  tbl = [];
  for (let t = 0; t < 4; t++) {
    const maxHp = cfg.types[t].hp;
    const row = new Float64Array(maxHp + 1);
    for (let hp = 1; hp <= maxHp; hp++) {
      if (t === LEADER) row[hp] = row[hp - 1] + (P.leaderMarginal[hp - 1] ?? 10);
      else row[hp] = P.unitBase[t] + P.unitPerHp[t] * hp;
    }
    tbl.push(row);
  }
  byP.set(P, tbl);
  return tbl;
}

function material(s, side, VAL) {
  const cfg = s.cfg;
  const us = cfg.sideUnits[side];
  const ut = cfg.unitType;
  let v = 0;
  for (let i = 0; i < us.length; i++) {
    const u = us[i];
    if (s.pos[u] >= 0) v += VAL[ut[u]][s.hp[u]];
  }
  return v;
}

// 位置評価。距離は「dmax - 距離」のボーナス形式にしている（dmax = 盤面の幅＋高さ−2 = 18）。
// （距離ペナルティ形式だと、敵ユニットを撃破した瞬間に項目が切り替わって評価が下がることがあるため）
function positional(s, side, P, aggro) {
  const cfg = s.cfg;
  const N = cfg.CELLS;
  const DM = cfg.dmax;
  const ut = cfg.unitType;
  const opp = side ^ 1;
  const mine = cfg.sideUnits[side];
  const theirs = cfg.sideUnits[opp];
  const elp = s.pos[cfg.leaderOf[opp]];
  let v = 0;
  // 前線の形成: 自陣の端（初期配置のリーダー側）から前へ進んだ行数（上限あり）
  const adv = P.advance;
  const homeBottom = adv && adv[1] + adv[2] + adv[3] > 0 ? cfg.start[side][cfg.leaderOf[side] - side * cfg.perSide] >= N / 2 : null;
  for (let i = 0; i < mine.length; i++) {
    const u = mine[i];
    const t = ut[u];
    if (t === LEADER) continue;
    const p = s.pos[u];
    if (p < 0) continue;
    if (homeBottom !== null) {
      const row = (p / cfg.W) | 0;
      const progress = homeBottom ? cfg.H - 1 - row : row;
      v += adv[t] * Math.min(progress, P.advanceCap[t]);
    }
    const tbl = cfg.atkDist[t];
    if (elp >= 0) v += P.approach[t] * aggro * (DM - Math.min(tbl[p * N + elp], DM));
    let m = DM;
    for (let j = 0; j < theirs.length; j++) {
      const q = s.pos[theirs[j]];
      if (q < 0) continue;
      const d = tbl[p * N + q];
      if (d < m) m = d;
    }
    v += P.engage[t] * (DM - m);
  }
  const myLeader = cfg.leaderOf[side];
  const lp = s.pos[myLeader];
  if (lp >= 0) {
    // 終盤: 敵がリーダーのみ、かつ自リーダーのHPが同等以上ならリーダーも追撃に加わる
    let enemyArmy = 0;
    for (let j = 0; j < theirs.length; j++) if (ut[theirs[j]] !== LEADER && s.pos[theirs[j]] >= 0) enemyArmy++;
    const hunt = enemyArmy === 0 && elp >= 0 && s.hp[myLeader] >= s.hp[cfg.leaderOf[opp]];
    if (hunt) v += P.endgameLeaderApproach * aggro * (DM - Math.min(cfg.atkDist[LEADER][lp * N + elp], DM));
    const nb = cfg.neighbors[lp];
    for (let i = 0; i < nb.length; i++) {
      for (let j = 0; j < mine.length; j++) {
        const u = mine[j];
        if (ut[u] !== LEADER && s.pos[u] === nb[i]) v += P.guard;
      }
    }
  }
  return v;
}

// ---------------------------------------------------------------------------
// 次ターンの攻撃可能性（脅威）
// ---------------------------------------------------------------------------

const MAX_CELLS = 256;
const CM_DIST = new Int8Array(MAX_CELLS);

/**
 * att 陣営の各ユニットが def 陣営の各ユニットを攻撃するのに必要な最小AP。
 * 移動経路・射線は現在の盤面で判定（攻撃者自身の現在マスは空きとみなす）。
 * 他の攻撃者の移動による変化は無視する近似。
 * @returns {Int8Array} costs[i * 人数 + j]（i, j は各陣営の並び順。不可能は INF）
 */
export function attackCostMatrix(s, att, occ, maxCost, out) {
  const cfg = s.cfg;
  const NP = cfg.perSide;
  const BW = cfg.W;
  const BH = cfg.H;
  const costs = out || new Int8Array(NP * NP);
  costs.fill(INF);
  const def = att ^ 1;
  const atts = cfg.sideUnits[att];
  const defs = cfg.sideUnits[def];
  for (let at = 0; at < NP; at++) {
    const a = atts[at];
    const ap = s.pos[a];
    if (ap < 0) continue;
    const T = cfg.types[cfg.unitType[a]];
    const budget = maxCost - T.attackCost;
    if (budget < 0) continue;
    bfsInto(cfg, ap, occ, Math.floor(budget / cfg.rules.moveCost), CM_DIST, null);
    for (let tt = 0; tt < NP; tt++) {
      const tu = defs[tt];
      const tp = s.pos[tu];
      if (tp < 0) continue;
      let best = INF;
      const tx = tp % BW;
      const ty = (tp / BW) | 0;
      for (let d = 0; d < 4; d++) {
        const dx = DIRS[d][0];
        const dy = DIRS[d][1];
        let x = tx;
        let y = ty;
        for (let k = 1; k <= T.maxRange; k++) {
          x += dx;
          y += dy;
          if (x < 0 || y < 0 || x >= BW || y >= BH) break;
          const c = y * BW + x;
          if (cfg.obstacle[c]) {
            if (T.obstacleBlocks) break;
            continue;
          }
          const o = occ[c];
          if (o >= 0 && o !== a) break;
          if (k >= T.minRange) {
            const dd = CM_DIST[c];
            if (dd >= 0 && dd < best) best = dd;
          }
        }
      }
      if (best < INF) costs[at * NP + tt] = best * cfg.rules.moveCost + T.attackCost;
    }
  }
  return costs;
}

/**
 * 攻撃側が AP=0..maxCost で与えられる最大の損害価値（各攻撃者は1回まで）。
 * @returns {Float64Array} best[a] = AP a 以下で達成可能な最大値
 */
function damageProfile(s, costs, att, maxCost, VAL, leaderKill) {
  const cfg = s.cfg;
  const NP = cfg.perSide;
  const defs = cfg.sideUnits[att ^ 1];
  const best = new Float64Array(maxCost + 1);
  const hits = new Array(NP).fill(0);
  const hp = new Array(NP);
  const alive = new Array(NP);
  const ttype = new Array(NP);
  for (let j = 0; j < NP; j++) {
    hp[j] = s.hp[defs[j]];
    alive[j] = s.pos[defs[j]] >= 0;
    ttype[j] = cfg.unitType[defs[j]];
  }
  // 攻撃可能な攻撃者だけを対象にする
  const attackers = [];
  for (let at = 0; at < NP; at++) {
    let any = false;
    for (let tt = 0; tt < NP; tt++) if (costs[at * NP + tt] <= maxCost) any = true;
    if (any) attackers.push(at);
  }
  if (attackers.length === 0) return best;
  const n = attackers.length;
  const rec = (i, spent) => {
    if (i === n) {
      let v = 0;
      for (let tt = 0; tt < NP; tt++) {
        const h = hits[tt];
        if (h === 0 || !alive[tt]) continue;
        const nh = hp[tt] - h;
        const ty = ttype[tt];
        if (nh <= 0) v += ty === LEADER ? leaderKill : VAL[ty][hp[tt]];
        else v += VAL[ty][hp[tt]] - VAL[ty][nh];
      }
      if (v > best[spent]) best[spent] = v;
      return;
    }
    rec(i + 1, spent);
    const at = attackers[i];
    for (let tt = 0; tt < NP; tt++) {
      const c = costs[at * NP + tt];
      if (spent + c > maxCost) continue;
      // 既に倒れる標的への追加攻撃は価値を増やさない（同じ価値をより少ないAPで達成できる）ので省く。結果は変わらない
      if (hits[tt] >= hp[tt]) continue;
      hits[tt]++;
      rec(i + 1, spent + c);
      hits[tt]--;
    }
  };
  rec(0, 0);
  for (let a = 1; a <= maxCost; a++) if (best[a - 1] > best[a]) best[a] = best[a - 1];
  return best;
}

function expectOver(profile, dist) {
  let e = 0;
  for (const [ap, p] of dist) e += p * profile[Math.min(ap, profile.length - 1)];
  return e;
}

// ---------------------------------------------------------------------------
// 評価関数
// ---------------------------------------------------------------------------

const EV_OCC = new Int8Array(MAX_CELLS);
const EV_COST_A = new Int8Array(64);
const EV_COST_B = new Int8Array(64);

function makeCtx(state, cpu) {
  const cfg = state.cfg;
  const P = cpu.params;
  return {
    cfg,
    P,
    cpu,
    VAL: valueTable(cfg, P),
    aggro: aggroFactor(P, roundOf(state)),
    stageInfo: [], // 強化段階ごとの { dist, max }
    me: state.side,
    oppStageInfo: [], // 相手の AP を楽観的に見積もるとき（cpu.oppApQuantile）の { dist, max }
  };
}

/**
 * 局面 s で side 陣営が「次に」得る AP の分布。s の時点の累計喪失数（その局面までの撃破を含む）
 * から決まる。こちらが敵を倒した局面では、相手の次のダイスが強化されることを織り込む。
 * cpu.oppApQuantile があるときは、相手の AP をその分位点（0.5 = 中央値）で頭打ちにして見積もる（難易度用）。
 * @returns {{dist: number[][], max: number}}
 */
function apInfo(ctx, s, side) {
  const st = stageOf(s.lost[side]);
  if (ctx.cpu.oppApQuantile !== undefined && side !== ctx.me) {
    let c = ctx.oppStageInfo[st];
    if (!c) ctx.oppStageInfo[st] = c = cappedDist(apDistribution(st), ctx.cpu.oppApQuantile);
    return c;
  }
  let e = ctx.stageInfo[st];
  if (!e) ctx.stageInfo[st] = e = { dist: apDistribution(st), max: maxAP(st) };
  return e;
}

/** AP の分布を、累積確率が q に届く AP で頭打ちにする（それより大きい AP の確率はその AP にまとめる） */
function cappedDist(dist, q) {
  let cdf = 0;
  let cap = dist[dist.length - 1][0];
  for (const [ap, p] of dist) {
    cdf += p;
    if (cdf >= q - 1e-9) {
      cap = ap;
      break;
    }
  }
  const out = [];
  let rest = 0;
  for (const [ap, p] of dist) {
    if (ap < cap) out.push([ap, p]);
    else rest += p;
  }
  out.push([cap, rest]);
  return { dist: out, max: cap };
}

function aggroFactor(P, round) {
  return 1 + P.aggroPerRound * round + Math.max(0, round - (P.lateAggroStart ?? 99)) * (P.lateAggroPerRound ?? 0);
}

/**
 * Stage1 評価: 自ターン終了時の局面（次は相手の手番）。me 視点。
 * 返り値は内訳つき。
 */
function fastEval(s, me, ctx) {
  const opp = me ^ 1;
  if (s.winner === me) return { total: WIN_SCORE, mat: WIN_SCORE, pos: 0, def: 0, off: 0 };
  const { P, VAL } = ctx;
  const mat = material(s, me, VAL) - material(s, opp, VAL);
  const pos = positional(s, me, P, ctx.aggro) - positional(s, opp, P, ctx.aggro);
  const occ = occupancy(s, EV_OCC);
  // 相手の次ターン（相手の喪失数＝このターンの撃破を反映）、自分の次々ターン
  const od = apInfo(ctx, s, opp);
  const md = apInfo(ctx, s, me);
  const oppCosts = attackCostMatrix(s, opp, occ, od.max, EV_COST_A);
  const myCosts = attackCostMatrix(s, me, occ, md.max, EV_COST_B);
  const def = expectOver(damageProfile(s, oppCosts, opp, od.max, VAL, P.leaderKillDef), od.dist);
  const off = expectOver(damageProfile(s, myCosts, me, md.max, VAL, P.leaderKillOff), md.dist);
  const total = mat + pos - P.wDefFast * def + P.wOffFast * off;
  return { total, mat, pos, def, off };
}

/** Stage2 の葉評価: 相手の反撃後（次は自分の手番）。me 視点。 */
function leafEval(s, me, ctx) {
  const opp = me ^ 1;
  if (s.pos[s.cfg.leaderOf[me]] < 0) return -WIN_SCORE;
  if (s.pos[s.cfg.leaderOf[opp]] < 0) return WIN_SCORE;
  const { P, VAL } = ctx;
  let v = material(s, me, VAL) - material(s, opp, VAL);
  v += positional(s, me, P, ctx.aggro) - positional(s, opp, P, ctx.aggro);
  const occ = occupancy(s, EV_OCC);
  // 自分の次ターン（相手の反撃で失ったユニットの分だけ強化されたダイス）、相手の次々ターン
  const md = apInfo(ctx, s, me);
  const od = apInfo(ctx, s, opp);
  const myCosts = attackCostMatrix(s, me, occ, md.max, EV_COST_A);
  const oppCosts = attackCostMatrix(s, opp, occ, od.max, EV_COST_B);
  v += P.wOffLeaf * expectOver(damageProfile(s, myCosts, me, md.max, VAL, P.leaderKillLeaf), md.dist);
  v -= P.wDefLeaf * expectOver(damageProfile(s, oppCosts, opp, od.max, VAL, P.leaderKillOff), od.dist);
  return v;
}

// ---------------------------------------------------------------------------
// Stage 1: 自ターンの行動列を全列挙（重複局面は排除）
// ---------------------------------------------------------------------------

// 局面キー（位置・HP・行動フラグ・残りAP）
let KEY_BUF = new Array(25);
function fullKey(s) {
  const n = s.pos.length;
  if (KEY_BUF.length !== 3 * n + 1) KEY_BUF = new Array(3 * n + 1);
  for (let i = 0; i < n; i++) {
    KEY_BUF[i] = s.pos[i] + 2;
    KEY_BUF[n + i] = s.hp[i] + 48;
    KEY_BUF[2 * n + i] = s.flags[i] + 48;
  }
  KEY_BUF[3 * n] = s.ap + 48;
  return String.fromCharCode.apply(null, KEY_BUF);
}
let BKEY_BUF = new Array(16);
function boardKey(s) {
  const n = s.pos.length;
  if (BKEY_BUF.length !== 2 * n) BKEY_BUF = new Array(2 * n);
  for (let i = 0; i < n; i++) {
    BKEY_BUF[i] = s.pos[i] + 2;
    BKEY_BUF[n + i] = s.hp[i] + 48;
  }
  return String.fromCharCode.apply(null, BKEY_BUF);
}

/**
 * 現在のAPで到達できる全てのターン終了局面を列挙する（幅優先、同一局面は最短手順のみ保持）。
 * 敵リーダーを撃破できる手順が見つかった時点で返す。
 */
export function enumerateTurn(root, { maxNodes = 200000 } = {}) {
  const cfg = root.cfg;
  const me = root.side;
  const seen = new Set();
  const boards = new Map(); // boardKey -> node
  const queue = [];
  const N = cfg.CELLS;
  const mine = cfg.sideUnits[me];
  const occ = new Int8Array(N);
  const dist = new Int8Array(N);
  const rootNode = { s: root, parent: null, action: null, depth: 0 };
  seen.add(fullKey(root));
  boards.set(boardKey(root), rootNode);
  queue.push(rootNode);
  let win = null;
  let expanded = 0;
  for (let qi = 0; qi < queue.length && !win; qi++) {
    const node = queue[qi];
    const s = node.s;
    if (s.ap <= 0) continue;
    if (++expanded > maxNodes) break;
    occupancy(s, occ);
    for (let ui = 0; ui < mine.length && !win; ui++) {
      const u = mine[ui];
      const p = s.pos[u];
      if (p < 0) continue;
      const f = s.flags[u];
      if (f & ATTACKED) continue;
      const T = cfg.types[cfg.unitType[u]];
      if (s.ap >= T.attackCost) {
        const targets = attackTargetsFrom(s, u, p, occ);
        for (let i = 0; i < targets.length; i++) {
          const tg = targets[i];
          const c = cloneState(s);
          mutAttack(c, u, tg.target, tg.dir, occ);
          const child = { s: c, parent: node, action: { type: 'attack', unit: u, target: tg.target }, depth: node.depth + 1 };
          if (c.winner === me) {
            win = child;
            break;
          }
          const k = fullKey(c);
          if (seen.has(k)) continue;
          seen.add(k);
          queue.push(child);
          const bk = boardKey(c);
          if (!boards.has(bk)) boards.set(bk, child);
        }
        if (win) break;
      }
      if (f & MOVED) continue;
      const steps = Math.floor(s.ap / cfg.rules.moveCost);
      if (steps < 1) continue;
      bfsInto(cfg, p, occ, steps, dist, null);
      for (let cell = 0; cell < N; cell++) {
        const d = dist[cell];
        if (d <= 0) continue;
        const cost = d * cfg.rules.moveCost;
        // 複製前にキーで重複判定（一時的に書き換えて戻す）
        s.pos[u] = cell;
        s.flags[u] = f | MOVED;
        s.ap -= cost;
        const k = fullKey(s);
        s.pos[u] = p;
        s.flags[u] = f;
        s.ap += cost;
        if (seen.has(k)) continue;
        seen.add(k);
        const c = cloneState(s);
        mutMove(c, u, cell, cost);
        const child = { s: c, parent: node, action: { type: 'move', unit: u, to: cell }, depth: node.depth + 1 };
        queue.push(child);
        const bk = boardKey(c);
        if (!boards.has(bk)) boards.set(bk, child);
      }
    }
  }
  return { win, terminals: [...boards.values()], nodes: queue.length, truncated: expanded > maxNodes };
}

function actionsOf(node) {
  const acts = [];
  for (let n = node; n && n.action; n = n.parent) {
    // ビームサーチのノードは単位行動（基本行動の配列）を持つ
    if (Array.isArray(n.action)) for (let i = n.action.length - 1; i >= 0; i--) acts.push(n.action[i]);
    else acts.push(n.action);
  }
  return acts.reverse();
}

// ---------------------------------------------------------------------------
// Stage 2: 相手の反撃探索
// ---------------------------------------------------------------------------

/**
 * 自ターン終了局面 S に対し、相手が AP=a（0..maxA）で選べる最も痛い反撃を探索する。
 * 相手の手は「（移動して）攻撃する」単位行動と、狙われたユニットの「退避移動」（安全度上位の数マス）の組み合わせ。
 * @returns {{value: Float64Array, nodes: number}} value[a] = AP a 以下で相手が選ぶ反撃後の me 視点評価（最小値）
 */
export function replySearch(S, me, ctx) {
  const cfg = S.cfg;
  const opp = me ^ 1;
  const maxA = apInfo(ctx, S, opp).max; // 相手が次に得られる最大 AP（自分の撃破で強化された段階を含む）
  const root = cloneState(S);
  root.side = opp;
  root.flags.fill(0);
  root.ap = maxA;
  root.phase = 'act';
  root.winner = null;
  const bestAt = new Float64Array(maxA + 1).fill(Infinity);
  const buckets = [];
  for (let i = 0; i <= maxA; i++) buckets.push([]);
  const seen = new Map();
  const N = cfg.CELLS;
  const BW = cfg.W;
  const BH = cfg.H;
  const theirs = cfg.sideUnits[opp];
  const mine = cfg.sideUnits[me];
  const myLeader = cfg.leaderOf[me];
  const occ = new Int8Array(N);
  const occ2 = new Int8Array(N);
  const dist = new Int8Array(N);
  root.spent = 0;
  seen.set(fullKey(root), 0);
  buckets[0].push(root);
  let nodes = 0;
  const cap = ctx.cpu.replyNodeCap;
  const push = (c, spent) => {
    c.ap = maxA - spent;
    const k = fullKey(c);
    const prev = seen.get(k);
    if (prev !== undefined && prev <= spent) return;
    seen.set(k, spent);
    c.spent = spent;
    c.key = k;
    buckets[spent].push(c);
  };
  const RB = ctx.cpu.replyBeam; // 打ち切り: { eval, flee, expand }
  // 局面 s（相手が spent AP 使用済み）から、相手の単位行動（退避移動・攻撃・移動して攻撃）をすべて展開する
  const expand = (s, spent) => {
    const rem = maxA - spent;
    occupancy(s, occ);
    let thr = null;
    for (let ti = 0; ti < theirs.length; ti++) {
      const a = theirs[ti];
      const t = cfg.unitType[a];
      const ap = s.pos[a];
      if (ap < 0) continue;
      const f = s.flags[a];
      if (f & ATTACKED) continue;
      const T = cfg.types[t];
      // 逃げる移動: 狙われているユニットを、こちらの攻撃が届きにくいマスへ退避させる
      const fleeK = P_flee(ctx)[t];
      if (!(f & MOVED) && fleeK > 0 && rem >= cfg.rules.moveCost) {
        if (!thr) thr = threatLevelMap(s, me, maxA);
        if (thr[ap] <= maxA) {
          bfsInto(cfg, ap, occ, Math.floor(rem / cfg.rules.moveCost), dist, null);
          const picks = topFleeCells(dist, thr, fleeK, N);
          for (let j = 0; j < picks.length; j++) {
            const c = cloneState(s);
            const mc = dist[picks[j]] * cfg.rules.moveCost;
            mutMove(c, a, picks[j], mc);
            c.flee = true;
            push(c, spent + mc);
          }
        }
      }
      if (T.attackCost > rem) continue;
      // その場で攻撃
      const here = attackTargetsFrom(s, a, ap, occ);
      for (let j = 0; j < here.length; j++) {
        const c = cloneState(s);
        mutAttack(c, a, here[j].target, here[j].dir, occ);
        push(c, spent + T.attackCost);
      }
      if (f & MOVED) continue;
      const steps = Math.floor((rem - T.attackCost) / cfg.rules.moveCost);
      if (steps < 1) continue;
      bfsInto(cfg, ap, occ, steps, dist, null);
      // 攻撃可能位置へ移動してから攻撃（標的・方向ごとに最も近いマスだけ）
      for (let mt = 0; mt < mine.length; mt++) {
        const m = mine[mt];
        const mp = s.pos[m];
        if (mp < 0) continue;
        const mx = mp % BW;
        const my = (mp / BW) | 0;
        for (let d = 0; d < 4; d++) {
          const dx = DIRS[d][0];
          const dy = DIRS[d][1];
          let x = mx;
          let y = my;
          let bestCell = -1;
          let bestDd = INF;
          for (let k = 1; k <= T.maxRange; k++) {
            x += dx;
            y += dy;
            if (x < 0 || y < 0 || x >= BW || y >= BH) break;
            const cell = y * BW + x;
            if (cfg.obstacle[cell]) {
              if (T.obstacleBlocks) break;
              continue;
            }
            const o = occ[cell];
            if (o >= 0 && o !== a) break;
            if (k < T.minRange) continue;
            const dd = dist[cell];
            if (dd <= 0) continue;
            if (dd < bestDd) {
              bestDd = dd;
              bestCell = cell;
            }
          }
          if (bestCell >= 0) {
            const moveCost = bestDd * cfg.rules.moveCost;
            const c = cloneState(s);
            mutMove(c, a, bestCell, moveCost);
            occupancy(c, occ2);
            mutAttack(c, a, m, (d + 2) % 4, occ2);
            push(c, spent + moveCost + T.attackCost);
          }
        }
      }
    }
  };
  {
    // ビーム: 各 AP 段で「こちらの素材の損失が大きい」局面を優先して葉評価し、評価の悪い順に一部だけ展開する。
    // 損失のない退避移動は素材では差がつかないので、別枠（RB.flee）で残す。
    const VAL = ctx.VAL;
    for (let spent = 0; spent <= maxA; spent++) {
      let list = buckets[spent].filter((s) => s.key === undefined || seen.get(s.key) === spent);
      if (list.length > RB.eval + RB.flee) {
        for (const s of list) s.q = material(s, me, VAL) - material(s, opp, VAL);
        const byQ = list.slice().sort((a, b) => a.q - b.q);
        const keep = byQ.slice(0, RB.eval);
        let fl = 0;
        for (let i = RB.eval; i < byQ.length && fl < RB.flee; i++) {
          if (byQ[i].flee) {
            keep.push(byQ[i]);
            fl++;
          }
        }
        list = keep;
      }
      for (const s of list) {
        nodes++;
        s.v = leafEval(s, me, ctx);
        if (s.v < bestAt[spent]) bestAt[spent] = s.v;
      }
      if (nodes > cap) continue;
      list.sort((a, b) => a.v - b.v);
      let ex = 0;
      for (let i = 0; i < list.length && ex < RB.expand; i++) {
        if (list[i].pos[myLeader] < 0) continue;
        expand(list[i], spent);
        ex++;
      }
    }
  }
  const value = new Float64Array(maxA + 1);
  let run = Infinity;
  for (let a = 0; a <= maxA; a++) {
    if (bestAt[a] < run) run = bestAt[a];
    value[a] = run;
  }
  return { value, nodes };
}

function P_flee(ctx) {
  return ctx.P.fleeCandidates || [0, 0, 0, 0];
}

/**
 * att 陣営の攻撃がマス c に届くまでの最小AP（障害物のみ考慮した静的近似）。
 * 反撃探索で相手ユニットの逃げ先を選ぶのに使う。
 */
function threatLevelMap(s, att, maxA) {
  const cfg = s.cfg;
  const N = cfg.CELLS;
  const thr = new Int8Array(N).fill(INF);
  const us = cfg.sideUnits[att];
  for (let i = 0; i < us.length; i++) {
    const p = s.pos[us[i]];
    if (p < 0) continue;
    const t = cfg.unitType[us[i]];
    const tbl = cfg.atkDist[t];
    const ac = cfg.types[t].attackCost;
    for (let c = 0; c < N; c++) {
      const v = tbl[p * N + c] * cfg.rules.moveCost + ac;
      if (v < thr[c]) thr[c] = v;
    }
  }
  return thr;
}

function topFleeCells(dist, thr, k, N) {
  const picks = [];
  for (let c = 0; c < N; c++) {
    if (dist[c] <= 0) continue;
    // 安全度が高い順、同じなら移動距離が短い順
    let i = picks.length;
    while (i > 0) {
      const q = picks[i - 1];
      if (thr[q] > thr[c] || (thr[q] === thr[c] && dist[q] <= dist[c])) break;
      i--;
    }
    if (i < k) {
      picks.splice(i, 0, c);
      if (picks.length > k) picks.pop();
    }
  }
  return picks;
}

// ---------------------------------------------------------------------------
// 大きな AP（最大 10AP）向けの探索: 軽い評価・ビームサーチ・事前選別
// ---------------------------------------------------------------------------

const tailCache = new WeakMap();
/** P(AP >= c) の表（c = 0..最大+1）。dist は apInfo が返す分布（同じ配列はキャッシュ） */
function tailOf(dist) {
  let t = tailCache.get(dist);
  if (t) return t;
  const max = dist[dist.length - 1][0];
  t = new Float64Array(max + 2);
  for (const [ap, p] of dist) for (let c = 0; c <= ap; c++) t[c] += p;
  tailCache.set(dist, t);
  return t;
}
function tailAt(t, c) {
  return c < t.length ? t[c] : 0;
}

/** 1 ダメージで失う価値（HP1 なら撃破） */
function hitValue(VAL, t, hp) {
  return hp <= 1 ? VAL[t][hp] : VAL[t][hp] - VAL[t][hp - 1];
}

const ST_COSTS = new Int16Array(16);
/**
 * att 陣営から def 陣営への静的な脅威（障害物だけを考慮。ユニットによる妨害と攻撃者どうしの干渉は無視）。
 * = リーダー撃破の確率 × leaderKill ＋ 1 ダメージの期待損失の大きい 2 体分。順位付け（ビーム・事前選別）にだけ使う。
 */
function staticThreat(s, att, dinfo, VAL, leaderKill) {
  const cfg = s.cfg;
  const N = cfg.CELLS;
  const atts = cfg.sideUnits[att];
  const defs = cfg.sideUnits[att ^ 1];
  const tail = tailOf(dinfo.dist);
  const mc = cfg.rules.moveCost;
  let b1 = 0;
  let b2 = 0;
  let lead = 0;
  for (let j = 0; j < defs.length; j++) {
    const d = defs[j];
    const q = s.pos[d];
    if (q < 0) continue;
    const t = cfg.unitType[d];
    const hp = s.hp[d];
    let n = 0;
    let cmin = INF;
    for (let i = 0; i < atts.length; i++) {
      const a = atts[i];
      const p = s.pos[a];
      if (p < 0) continue;
      const ta = cfg.unitType[a];
      const m = cfg.atkDist[ta][p * N + q];
      if (m >= INF) continue;
      const c = m * mc + cfg.types[ta].attackCost;
      if (c < cmin) cmin = c;
      if (t === LEADER) ST_COSTS[n++] = c;
    }
    if (cmin >= INF) continue;
    const h = tailAt(tail, cmin) * hitValue(VAL, t, hp);
    if (h > b1) {
      b2 = b1;
      b1 = h;
    } else if (h > b2) b2 = h;
    if (t === LEADER && n >= hp) {
      const arr = ST_COSTS.subarray(0, n).sort();
      let kc = 0;
      for (let k = 0; k < hp; k++) kc += arr[k];
      lead += tailAt(tail, kc) * leaderKill;
    }
  }
  return lead + b1 + b2;
}

/** 軽い静的評価（me 視点、自ターン終了時）。fastEval の脅威計算を静的な近似に置き換えたもの */
function cheapEval(s, me, ctx) {
  const opp = me ^ 1;
  if (s.winner === me) return WIN_SCORE;
  const { P, VAL } = ctx;
  let v = material(s, me, VAL) - material(s, opp, VAL);
  v += positional(s, me, P, ctx.aggro) - positional(s, opp, P, ctx.aggro);
  v -= P.wDefFast * staticThreat(s, opp, apInfo(ctx, s, opp), VAL, P.leaderKillDef);
  v += P.wOffFast * staticThreat(s, me, apInfo(ctx, s, me), VAL, P.leaderKillOff);
  return v;
}

/**
 * ユニット u がマス cell にいるときの局所的な評価（移動先の候補を絞るためだけに使う）。
 * 非リーダー: 前線・接近・交戦の位置評価 − 危険度。リーダー: 護衛・追撃 − 撃破される危険度。
 */
function localScore(s, u, cell, me, ctx, thr, tail, homeBottom) {
  const cfg = s.cfg;
  const { P, VAL } = ctx;
  const N = cfg.CELLS;
  const DM = cfg.dmax;
  const t = cfg.unitType[u];
  const opp = me ^ 1;
  const theirs = cfg.sideUnits[opp];
  const elp = s.pos[cfg.leaderOf[opp]];
  let v = 0;
  if (t !== LEADER) {
    if (homeBottom !== null) {
      const row = (cell / cfg.W) | 0;
      v += P.advance[t] * Math.min(homeBottom ? cfg.H - 1 - row : row, P.advanceCap[t]);
    }
    const tbl = cfg.atkDist[t];
    if (elp >= 0) v += P.approach[t] * ctx.aggro * (DM - Math.min(tbl[cell * N + elp], DM));
    let m = DM;
    for (let j = 0; j < theirs.length; j++) {
      const q = s.pos[theirs[j]];
      if (q >= 0 && tbl[cell * N + q] < m) m = tbl[cell * N + q];
    }
    v += P.engage[t] * (DM - m);
    if (thr[cell] < INF) v -= P.wDefFast * tailAt(tail, thr[cell]) * hitValue(VAL, t, s.hp[u]);
    return v;
  }
  // リーダー
  const mine = cfg.sideUnits[me];
  const nb = cfg.neighbors[cell];
  for (let i = 0; i < nb.length; i++) {
    for (let j = 0; j < mine.length; j++) if (mine[j] !== u && s.pos[mine[j]] === nb[i]) v += P.guard;
  }
  let n = 0;
  for (let i = 0; i < theirs.length; i++) {
    const a = theirs[i];
    const p = s.pos[a];
    if (p < 0) continue;
    const ta = cfg.unitType[a];
    const m = cfg.atkDist[ta][p * N + cell];
    if (m < INF) ST_COSTS[n++] = m * cfg.rules.moveCost + cfg.types[ta].attackCost;
  }
  const hp = s.hp[u];
  if (n > 0) {
    const arr = ST_COSTS.subarray(0, n).sort();
    v -= P.wDefFast * tailAt(tail, arr[0]) * hitValue(VAL, LEADER, hp);
    if (n >= hp) {
      let kc = 0;
      for (let k = 0; k < hp; k++) kc += arr[k];
      v -= P.wDefFast * tailAt(tail, kc) * P.leaderKillDef;
    }
  }
  return v;
}

/**
 * Stage 1（大きな AP）: 単位行動のビームサーチ。enumerateTurn と同じ形 { win, terminals, nodes, truncated } を返す。
 * terminals の各ノードは軽い評価 cheap を持つ。node.action は単位行動（1〜2 個の基本行動の配列）。
 */
export function beamTurn(root, ctx, opts = {}) {
  const o = { ...ctx.cpu, ...opts };
  const cfg = root.cfg;
  const me = root.side;
  const opp = me ^ 1;
  const N = cfg.CELLS;
  const mc = cfg.rules.moveCost;
  const mine = cfg.sideUnits[me];
  const P = ctx.P;
  const adv = P.advance;
  const homeBottom = adv && adv[1] + adv[2] + adv[3] > 0 ? cfg.start[me][cfg.leaderOf[me] - me * cfg.perSide] >= N / 2 : null;
  const deadline = o.deadline ?? Infinity;
  const seen = new Set();
  const occ = new Int8Array(N);
  const occ2 = new Int8Array(N);
  const dist = new Int8Array(N);
  const rootNode = { s: root, parent: null, action: null, depth: 0, cheap: cheapEval(root, me, ctx) };
  seen.add(fullKey(root));
  const all = [rootNode];
  let beam = [rootNode];
  let next = [];
  let gen = 0;
  let truncated = false;
  let win = null;
  const add = (node, c, acts) => {
    if (c.winner === me) {
      win = { s: c, parent: node, action: acts, depth: node.depth + acts.length };
      return;
    }
    const k = fullKey(c);
    if (seen.has(k)) return;
    seen.add(k);
    gen++;
    const child = { s: c, parent: node, action: acts, depth: node.depth + acts.length, cheap: cheapEval(c, me, ctx) };
    all.push(child);
    if (c.ap > 0) next.push(child);
  };
  const keepTop = (arr, item, k) => {
    // arr は score の降順。k 個まで
    let i = arr.length;
    while (i > 0 && arr[i - 1].score < item.score) i--;
    if (i < k) {
      arr.splice(i, 0, item);
      if (arr.length > k) arr.pop();
    }
  };
  while (beam.length && !win) {
    next = [];
    for (let bi = 0; bi < beam.length && !win; bi++) {
      if (gen > o.maxGen || now() > deadline) {
        truncated = true;
        break;
      }
      const node = beam[bi];
      const s = node.s;
      occupancy(s, occ);
      const od = apInfo(ctx, s, opp);
      const tail = tailOf(od.dist);
      const thr = threatLevelMap(s, opp, od.max);
      for (let ui = 0; ui < mine.length && !win; ui++) {
        const u = mine[ui];
        const p = s.pos[u];
        if (p < 0) continue;
        const f = s.flags[u];
        if (f & ATTACKED) continue;
        const T = cfg.types[cfg.unitType[u]];
        // その場で攻撃
        if (s.ap >= T.attackCost) {
          const tg = attackTargetsFrom(s, u, p, occ);
          for (let i = 0; i < tg.length && !win; i++) {
            const c = cloneState(s);
            mutAttack(c, u, tg[i].target, tg[i].dir, occ);
            add(node, c, [{ type: 'attack', unit: u, target: tg[i].target }]);
          }
        }
        if (f & MOVED) continue;
        const steps = Math.floor(s.ap / mc);
        if (steps < 1) continue;
        bfsInto(cfg, p, occ, steps, dist, null);
        const moves = [];
        const atk = new Map(); // (標的, 方向) -> 候補 [{cell, cost, score}]
        for (let cell = 0; cell < N; cell++) {
          const d = dist[cell];
          if (d <= 0) continue;
          const cost = d * mc;
          const sc = localScore(s, u, cell, me, ctx, thr, tail, homeBottom) - 0.01 * d;
          keepTop(moves, { cell, cost, score: sc }, o.moveK);
          if (cost + T.attackCost > s.ap) continue;
          const tg = attackTargetsFrom(s, u, cell, occ);
          for (let i = 0; i < tg.length; i++) {
            const key = tg[i].target * 4 + tg[i].dir;
            let arr = atk.get(key);
            if (!arr) atk.set(key, (arr = []));
            const item = { cell, cost, score: sc, target: tg[i].target };
            // 候補: 位置の評価が良いマス atkCells 個＋最も安いマス（残りの AP を他のユニットに回せる）
            keepTop(arr, item, o.atkCells);
            if (!arr.cheapest || cost < arr.cheapest.cost || (cost === arr.cheapest.cost && sc > arr.cheapest.score)) arr.cheapest = item;
          }
        }
        // 移動して攻撃（標的・方向ごとに最安のマスも必ず含める）
        for (const arr of atk.values()) {
          if (!arr.includes(arr.cheapest)) arr.push(arr.cheapest);
          for (let i = 0; i < arr.length && !win; i++) {
            const m = arr[i];
            const c = cloneState(s);
            mutMove(c, u, m.cell, m.cost);
            occupancy(c, occ2);
            const tg = attackTargetsFrom(c, u, m.cell, occ2).find((x) => x.target === m.target);
            mutAttack(c, u, m.target, tg.dir, occ2);
            add(node, c, [
              { type: 'move', unit: u, to: m.cell },
              { type: 'attack', unit: u, target: m.target },
            ]);
          }
        }
        // 移動のみ
        for (let i = 0; i < moves.length && !win; i++) {
          const c = cloneState(s);
          mutMove(c, u, moves[i].cell, moves[i].cost);
          add(node, c, [{ type: 'move', unit: u, to: moves[i].cell }]);
        }
      }
    }
    if (truncated) break;
    next.sort((a, b) => b.cheap - a.cheap);
    beam = next.length > o.beamWidth ? next.slice(0, o.beamWidth) : next;
  }
  // 同じ盤面（位置・HP）になる終局面は、行動数の少ないものだけ残す
  const boards = new Map();
  for (const n of all) {
    const bk = boardKey(n.s);
    const prev = boards.get(bk);
    if (!prev || n.depth < prev.depth) boards.set(bk, n);
  }
  return { win, terminals: [...boards.values()], nodes: gen, truncated };
}

/** 事前選別: 軽い評価の上位・素材の得の上位・何もしない局面だけを本来の評価にかける */
function preselect(terms, me, ctx, o) {
  if (terms.length <= o.preEval + o.preGain) return terms;
  const opp = me ^ 1;
  for (const n of terms) {
    if (n.cheap === undefined) n.cheap = cheapEval(n.s, me, ctx);
    n.matGain = material(n.s, me, ctx.VAL) - material(n.s, opp, ctx.VAL);
  }
  const pick = new Set(terms.filter((n) => n.depth === 0));
  const byCheap = terms.slice().sort((a, b) => b.cheap - a.cheap);
  for (let i = 0; i < o.preEval; i++) pick.add(byCheap[i]);
  const byGain = terms.slice().sort((a, b) => b.matGain - a.matGain || b.cheap - a.cheap);
  for (let i = 0; i < o.preGain; i++) pick.add(byGain[i]);
  return [...pick];
}

// ---------------------------------------------------------------------------
// メイン: ターンの行動計画
// ---------------------------------------------------------------------------

/**
 * 手番の陣営の行動計画を立てる。
 * @param {object} state 自分の手番で phase='act'（AP 確定済み）
 * @param {{cpu?: object, rng?: () => number, prevStart?: number[]}} opts
 *   prevStart: 前のターンの開始時の駒の位置（難易度の往復防止用。cpu.pickTemp があるときだけ使う）
 * @returns {{actions: object[], info: object}} actions はルールエンジンでそのまま適用できる行動の列
 */
export function planTurn(state, opts = {}) {
  const cpu = opts.cpu || CPU;
  const rng = opts.rng || Math.random;
  const t0 = now();
  const me = state.side;
  const ctx = makeCtx(state, cpu);
  const deadline = t0 + cpu.timeLimitMs;
  const useBeam = state.ap > cpu.exactMaxAP;

  const enumRes = useBeam ? beamTurn(state, ctx, { deadline: t0 + 0.4 * cpu.timeLimitMs }) : enumerateTurn(state);
  if (enumRes.win) {
    return {
      actions: actionsOf(enumRes.win),
      info: { ap: state.ap, reason: 'win', search: useBeam ? 'beam' : 'exact', nodes: enumRes.nodes, ms: now() - t0 },
    };
  }

  const allTerms = enumRes.terminals;
  const terms = preselect(allTerms, me, ctx, cpu);
  for (const node of terms) {
    node.fast = fastEval(node.s, me, ctx);
    node.noise = cpu.noise ? (rng() - 0.5) * cpu.noise : 0;
  }

  // 反撃探索にかける候補: 総合・防御重視・即時の戦果の上位を交互に（時間切れに備える）
  const P = cpu.params;
  const byTotal = terms.slice().sort((a, b) => b.fast.total - a.fast.total);
  const bySafe = terms.slice().sort((a, b) => b.fast.mat + b.fast.pos - 2 * P.wDefFast * b.fast.def - (a.fast.mat + a.fast.pos - 2 * P.wDefFast * a.fast.def));
  const byGain = terms.slice().sort((a, b) => b.fast.mat - a.fast.mat || b.fast.total - a.fast.total);
  const pick = new Set();
  for (let i = 0; i < Math.max(cpu.topK, cpu.topSafe, cpu.topGain); i++) {
    if (i < cpu.topK && byTotal[i]) pick.add(byTotal[i]);
    if (i < cpu.topSafe && bySafe[i]) pick.add(bySafe[i]);
    if (i < cpu.topGain && byGain[i]) pick.add(byGain[i]);
  }
  let chosen;
  let best = -Infinity;
  let replyNodes = 0;
  let timeCut = false;
  for (const node of pick) {
    if (chosen && now() > deadline) {
      timeCut = true;
      break;
    }
    const r = replySearch(node.s, me, ctx);
    replyNodes += r.nodes;
    node.deep = expectOver(r.value, apInfo(ctx, node.s, me ^ 1).dist);
    const sc = node.deep + 0.05 * node.fast.total - P.actionPenalty * node.depth + node.noise;
    if (cpu.pickTemp) {
      node.sc = sc;
      node.worst = r.value[r.value.length - 1]; // 想定する最大の AP で相手が選ぶ最悪の評価
    }
    if (sc > best) {
      best = sc;
      chosen = node;
    }
  }

  const info = { ap: state.ap, search: useBeam ? 'beam' : 'exact', nodes: enumRes.nodes, terminals: allTerms.length, candidates: pick.size, replyNodes, ms: now() - t0, truncated: !!enumRes.truncated, timeCut };
  if (cpu.pickTemp && chosen) {
    const best0 = chosen;
    chosen = pickNearBest([...pick], chosen, best, state, cpu, rng, opts.prevStart);
    info.slipped = chosen !== best0;
  }
  return { actions: actionsOf(chosen), info };
}

/**
 * 難易度用: 最善手から cpu.pickMaxDrop 点以内の候補を、差が小さいほど選ばれやすい確率（温度 cpu.pickTemp）で 1 つ選ぶ。
 * どの候補も相手の反撃まで読んだ計画なので、1 手ずつ見れば筋は通っている。次の安全柵を付ける。
 *  - cpu.pickSafe: 最善手が想定内の AP でリーダーを失わないなら、失う候補は選ばない
 *  - prevStart（前のターンの開始時の駒の位置）: 駒を前のターンの位置へ戻す候補は、最善手でなければ選ばない（往復を防ぐ）
 * 勝てる手順はこの処理の前に返しているので、届く勝ちは必ず取る。
 */
function pickNearBest(cands, chosen, best, state, cpu, rng, prevStart) {
  const me = state.side;
  const safeBest = !cpu.pickSafe || chosen.worst > -WIN_SCORE / 2;
  const backtracks = (n) => {
    if (!prevStart) return false;
    for (const u of state.cfg.sideUnits[me]) {
      const f = prevStart[u];
      if (f >= 0 && n.s.pos[u] === f && state.pos[u] !== f) return true;
    }
    return false;
  };
  const pool = cands.filter(
    (n) =>
      n.sc !== undefined &&
      n.sc >= best - (cpu.pickMaxDrop ?? Infinity) &&
      (!cpu.pickSafe || !safeBest || n.worst > -WIN_SCORE / 2) &&
      (n === chosen || !backtracks(n)),
  );
  let z = 0;
  for (const n of pool) z += n.w = Math.exp((n.sc - best) / cpu.pickTemp);
  let r = rng() * z;
  for (const n of pool) {
    r -= n.w;
    if (r <= 0) return n;
  }
  return chosen;
}

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export { actionsOf, makeCtx, cappedDist, pickNearBest };
