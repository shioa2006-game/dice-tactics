// DICE TACTICS 基本形 — ルールエンジン
// UI・CPU・テストはすべてこのモジュールの判定関数を共有する。
// 状態はイミュータブルに扱い、beginTurn / applyAction / endTurn は新しい状態を返す。

import { LEADER, MOVED, ATTACKED, DIRS, HUMAN } from './config.js';
import { BASE_AP, diceMaxes, stageOf, rollDice } from './dice.js';

// ---------------------------------------------------------------------------
// 状態
// ---------------------------------------------------------------------------

/**
 * 新しいゲームを作る。最初のターンはダイス待ち（phase = 'roll'）。
 * @param {object} cfg makeConfig() の戻り値
 * @param {{firstSide?: number}} opts
 */
export function createGame(cfg, { firstSide = HUMAN } = {}) {
  const n = cfg.unitCount;
  const pos = new Int8Array(n);
  const hp = new Int8Array(n);
  for (let u = 0; u < n; u++) {
    const side = cfg.unitSide[u];
    pos[u] = cfg.start[side][u - side * cfg.perSide];
    hp[u] = pos[u] >= 0 ? cfg.types[cfg.unitType[u]].hp : 0;
  }
  return {
    cfg,
    pos, // ユニットのマス（撃破済みは -1）
    hp,
    flags: new Uint8Array(n), // このターンの行動（MOVED / ATTACKED）
    side: firstSide, // 手番の陣営
    firstSide,
    ap: 0, // 残り AP
    apGained: 0, // このターンに得た AP
    dice: null, // このターンの出目
    diceMax: null, // このターンのダイスの最大値
    phase: 'roll', // 'roll'（ダイス待ち）| 'act'（行動中）| 'over'（終了）
    turn: 1, // 通算ターン（ラウンド = ceil(turn / 2)）
    winner: null, // HUMAN | MONSTER | 'draw'
    lost: [0, 0], // 各陣営のリーダー以外の累計喪失数（ダイスの強化段階を決める）
  };
}

export function cloneState(s) {
  return {
    cfg: s.cfg,
    pos: s.pos.slice(),
    hp: s.hp.slice(),
    flags: s.flags.slice(),
    side: s.side,
    firstSide: s.firstSide,
    ap: s.ap,
    apGained: s.apGained,
    dice: s.dice ? s.dice.slice() : null,
    diceMax: s.diceMax,
    phase: s.phase,
    turn: s.turn,
    winner: s.winner,
    lost: s.lost.slice(),
  };
}

export function roundOf(s) {
  return Math.ceil(s.turn / 2);
}

/** マスごとのユニット番号（いなければ -1）。out は cfg.CELLS 以上の長さ */
export function occupancy(s, out) {
  const occ = out || new Int8Array(s.cfg.CELLS);
  occ.fill(-1);
  const pos = s.pos;
  for (let u = 0; u < pos.length; u++) if (pos[u] >= 0) occ[pos[u]] = u;
  return occ;
}

export function unitAt(s, cell) {
  for (let u = 0; u < s.pos.length; u++) if (s.pos[u] === cell) return u;
  return -1;
}

// ---------------------------------------------------------------------------
// ダイスと AP（被害連動ダイス。詳細は dice.js）
// ---------------------------------------------------------------------------

/** side 陣営が次に振るダイスの各最大値（累計喪失数で増える） */
export function diceMaxOf(s, side = s.side) {
  return diceMaxes(s.lost[side]);
}

/** side 陣営のダイス強化段階（0〜3） */
export function diceStageOf(s, side = s.side) {
  return stageOf(s.lost[side]);
}

/** 手番の陣営のダイスを振る */
export function rollDiceFor(s, rng) {
  return rollDice(rng, diceMaxOf(s));
}

/**
 * ダイスの結果を反映してターンを開始する。
 * ダイスの最大値は「この時点の」自軍の累計喪失数で決まる（強化は次の AP 獲得時から適用）。
 */
export function beginTurn(s, dice) {
  if (s.phase !== 'roll') throw new Error('beginTurn: phase is ' + s.phase);
  const maxes = diceMaxOf(s);
  if (!dice || dice.length !== maxes.length) throw new Error('beginTurn: dice required');
  for (let i = 0; i < maxes.length; i++) {
    if (!(Number.isInteger(dice[i]) && dice[i] >= 0 && dice[i] <= maxes[i])) throw new Error(`beginTurn: die ${i} = ${dice[i]} (0〜${maxes[i]})`);
  }
  const n = cloneState(s);
  n.dice = dice.slice();
  n.diceMax = maxes;
  n.ap = BASE_AP + dice.reduce((a, b) => a + b, 0);
  n.apGained = n.ap;
  n.phase = 'act';
  return n;
}

// ---------------------------------------------------------------------------
// 移動
// ---------------------------------------------------------------------------

/**
 * from から空きマスのみを通る幅優先探索。dist[c] = 移動マス数（到達不能は -1）。
 * occ 上で from 自身のマスは出発点として扱う。
 */
export function bfsInto(cfg, from, occ, maxCost, dist, prev) {
  dist.fill(-1);
  if (prev) prev.fill(-1);
  dist[from] = 0;
  const q = BFS_QUEUE;
  const nbs = cfg.neighbors;
  const obstacle = cfg.obstacle;
  let head = 0;
  let tail = 0;
  q[tail++] = from;
  while (head < tail) {
    const c = q[head++];
    const d = dist[c];
    if (d >= maxCost) continue;
    const nb = nbs[c];
    for (let i = 0; i < nb.length; i++) {
      const n = nb[i];
      if (dist[n] >= 0 || obstacle[n] || occ[n] >= 0) continue;
      dist[n] = d + 1;
      if (prev) prev[n] = c;
      q[tail++] = n;
    }
  }
  return dist;
}
const BFS_QUEUE = new Int16Array(1024);

export function canMove(s, u) {
  return s.phase === 'act' && s.pos[u] >= 0 && s.cfg.unitSide[u] === s.side && s.flags[u] === 0 && s.ap >= s.cfg.rules.moveCost;
}

/** 移動可能範囲: { dist, prev }（maxCost を上限とする） */
export function reachable(s, u, maxCost = s.ap) {
  const occ = occupancy(s);
  const dist = new Int8Array(s.cfg.CELLS);
  const prev = new Int8Array(s.cfg.CELLS);
  bfsInto(s.cfg, s.pos[u], occ, Math.floor(maxCost / s.cfg.rules.moveCost), dist, prev);
  return { dist, prev };
}

/** 選択可能な移動先の一覧 [{cell, cost, path}] */
export function moveOptions(s, u) {
  if (!canMove(s, u)) return [];
  const { dist, prev } = reachable(s, u, s.ap);
  const out = [];
  for (let c = 0; c < s.cfg.CELLS; c++) {
    if (dist[c] > 0) out.push({ cell: c, cost: dist[c] * s.cfg.rules.moveCost, path: pathTo(prev, s.pos[u], c) });
  }
  return out;
}

export function pathTo(prev, from, to) {
  const path = [];
  let c = to;
  while (c !== from && c >= 0) {
    path.push(c);
    c = prev[c];
  }
  path.reverse();
  return path;
}

// ---------------------------------------------------------------------------
// 攻撃
// ---------------------------------------------------------------------------

export function canAttack(s, u) {
  return s.phase === 'act' && s.pos[u] >= 0 && s.cfg.unitSide[u] === s.side && (s.flags[u] & ATTACKED) === 0 && s.ap >= s.cfg.types[s.cfg.unitType[u]].attackCost;
}

/**
 * from マスにいる（と仮定した）ユニット u が攻撃できる敵の一覧。AP・行動済みフラグは考慮しない。
 * u 自身の現在マスは空きマスとして扱う（移動後の攻撃の予測に使うため）。
 * 返り値: [{target, cell, dir, dist, overObstacle}]
 */
export function attackTargetsFrom(s, u, from, occ) {
  const cfg = s.cfg;
  const T = cfg.types[cfg.unitType[u]];
  const side = cfg.unitSide[u];
  const unitSide = cfg.unitSide;
  const obstacle = cfg.obstacle;
  const BW = cfg.W;
  const BH = cfg.H;
  const res = [];
  const fx = from % BW;
  const fy = (from / BW) | 0;
  for (let d = 0; d < 4; d++) {
    const dx = DIRS[d][0];
    const dy = DIRS[d][1];
    let x = fx;
    let y = fy;
    let crossed = false;
    for (let k = 1; k <= T.maxRange; k++) {
      x += dx;
      y += dy;
      if (x < 0 || y < 0 || x >= BW || y >= BH) break;
      const c = y * BW + x;
      if (obstacle[c]) {
        if (T.obstacleBlocks) break;
        crossed = true;
        continue;
      }
      const o = occ[c];
      if (o >= 0 && o !== u) {
        if (k >= T.minRange && unitSide[o] !== side) res.push({ target: o, cell: c, dir: d, dist: k, overObstacle: crossed });
        break; // 最初のユニットで射線は止まる
      }
    }
  }
  return res;
}

/**
 * 攻撃結果の予測（押し出し先など）。applyAction と同じ関数で計算する。
 * @returns {{kills:boolean, knockback:boolean, dest:number, blocked:null|'edge'|'obstacle'|'unit'}}
 */
export function predictHit(s, u, target, dir, occ) {
  const cfg = s.cfg;
  const T = cfg.types[cfg.unitType[u]];
  if (s.hp[target] - 1 <= 0) return { kills: true, knockback: false, dest: -1, blocked: null };
  if (!T.knockback) return { kills: false, knockback: false, dest: -1, blocked: null };
  const tc = s.pos[target];
  const nx = (tc % cfg.W) + DIRS[dir][0];
  const ny = ((tc / cfg.W) | 0) + DIRS[dir][1];
  if (nx < 0 || ny < 0 || nx >= cfg.W || ny >= cfg.H) return { kills: false, knockback: true, dest: -1, blocked: 'edge' };
  const c = ny * cfg.W + nx;
  if (cfg.obstacle[c]) return { kills: false, knockback: true, dest: -1, blocked: 'obstacle' };
  if (occ[c] >= 0) return { kills: false, knockback: true, dest: -1, blocked: 'unit' };
  return { kills: false, knockback: true, dest: c, blocked: null };
}

/** 現在位置から実行可能な攻撃 [{target, cell, dir, dist, overObstacle, cost, hit}] */
export function attackOptions(s, u) {
  if (!canAttack(s, u)) return [];
  const occ = occupancy(s);
  const cost = s.cfg.types[s.cfg.unitType[u]].attackCost;
  return attackTargetsFrom(s, u, s.pos[u], occ).map((t) => ({ ...t, cost, hit: predictHit(s, u, t.target, t.dir, occ) }));
}

// ---------------------------------------------------------------------------
// 行動の検証と適用
// ---------------------------------------------------------------------------

/** 行動が合法なら null、違法なら理由の文字列を返す */
export function validateAction(s, a) {
  const cfg = s.cfg;
  if (s.phase === 'over') return 'ゲームは終了しています';
  if (!a || typeof a.type !== 'string') return '不正な行動です';
  if (a.type === 'end') return s.phase === 'act' ? null : 'ダイスを振る前にターンを終了できません';
  if (s.phase !== 'act') return 'ダイスを振ってください';
  const u = a.unit;
  if (!(u >= 0 && u < cfg.unitCount)) return '不正なユニットです';
  if (s.pos[u] < 0) return 'そのユニットは撃破されています';
  if (cfg.unitSide[u] !== s.side) return '相手のユニットは操作できません';
  if (a.type === 'move') {
    if (s.flags[u] & ATTACKED) return '攻撃後は移動できません';
    if (s.flags[u] & MOVED) return 'このターンは既に移動しました';
    if (!(a.to >= 0 && a.to < cfg.CELLS)) return '盤面外には移動できません';
    if (a.to === s.pos[u]) return '同じマスには移動できません';
    const { dist } = reachable(s, u, s.ap);
    if (dist[a.to] <= 0) {
      if (cfg.obstacle[a.to]) return '障害物には移動できません';
      if (unitAt(s, a.to) >= 0) return 'ユニットのいるマスには移動できません';
      return 'APが足りないか、到達できないマスです';
    }
    return null;
  }
  if (a.type === 'attack') {
    const cost = cfg.types[cfg.unitType[u]].attackCost;
    if (s.flags[u] & ATTACKED) return 'このターンは既に攻撃しました';
    if (s.ap < cost) return `APが足りません（攻撃に${cost}AP必要）`;
    const t = a.target;
    if (!(t >= 0 && t < cfg.unitCount) || s.pos[t] < 0) return '攻撃対象がいません';
    if (cfg.unitSide[t] === cfg.unitSide[u]) return '味方は攻撃できません';
    const occ = occupancy(s);
    if (!attackTargetsFrom(s, u, s.pos[u], occ).some((x) => x.target === t)) return '射程外か、射線が遮られています';
    return null;
  }
  return '不明な行動です';
}

/**
 * 行動を適用して { state, events } を返す。違法な行動は例外。
 * events: move（経路つき）/ attack / damage / kill / win / knockback / knockbackBlocked / endTurn / draw
 */
export function applyAction(s, a) {
  const err = validateAction(s, a);
  if (err) throw new Error('Illegal action: ' + err + ' ' + JSON.stringify(a));
  if (a.type === 'end') return endTurnWithEvents(s);
  const cfg = s.cfg;
  const n = cloneState(s);
  const events = [];
  if (a.type === 'move') {
    const occ = occupancy(s);
    const dist = new Int8Array(cfg.CELLS);
    const prev = new Int8Array(cfg.CELLS);
    bfsInto(cfg, s.pos[a.unit], occ, Math.floor(s.ap / cfg.rules.moveCost), dist, prev);
    const path = pathTo(prev, s.pos[a.unit], a.to);
    const cost = dist[a.to] * cfg.rules.moveCost;
    events.push({ type: 'move', unit: a.unit, from: s.pos[a.unit], to: a.to, path, cost });
    mutMove(n, a.unit, a.to, cost);
  } else {
    const occ = occupancy(s);
    const info = attackTargetsFrom(s, a.unit, s.pos[a.unit], occ).find((x) => x.target === a.target);
    const cost = cfg.types[cfg.unitType[a.unit]].attackCost;
    events.push({ type: 'attack', unit: a.unit, target: a.target, from: s.pos[a.unit], to: s.pos[a.target], dir: info.dir, dist: info.dist, overObstacle: info.overObstacle, cost });
    const r = mutAttack(n, a.unit, a.target, info.dir, occ);
    events.push({ type: 'damage', unit: a.target, hp: n.hp[a.target] });
    if (r.killed) {
      events.push({ type: 'kill', unit: a.target, at: s.pos[a.target] });
      if (cfg.unitType[a.target] === LEADER) events.push({ type: 'win', side: cfg.unitSide[a.unit] });
    } else if (r.knockback) {
      if (r.dest >= 0) events.push({ type: 'knockback', unit: a.target, from: s.pos[a.target], to: r.dest });
      else events.push({ type: 'knockbackBlocked', unit: a.target, at: s.pos[a.target], reason: r.blocked });
    }
  }
  return { state: n, events };
}

/** ターン終了（新しい状態のみ返す） */
export function endTurn(s) {
  return endTurnWithEvents(s).state;
}

function endTurnWithEvents(s) {
  if (s.phase !== 'act') throw new Error('endTurn: phase is ' + s.phase);
  const n = cloneState(s);
  const events = [{ type: 'endTurn', side: s.side, unusedAP: s.ap }];
  n.flags.fill(0);
  n.ap = 0; // AP は持ち越さない
  n.apGained = 0;
  n.dice = null;
  n.diceMax = null;
  if (n.turn >= 2 * s.cfg.rules.maxRounds) {
    n.phase = 'over';
    n.winner = 'draw';
    events.push({ type: 'draw' });
  } else {
    n.turn += 1;
    n.side = s.side ^ 1;
    n.phase = 'roll';
  }
  return { state: n, events };
}

// ---------------------------------------------------------------------------
// 検証済み前提の内部適用関数（CPU の探索用。合法手の生成と組で使う）
// ---------------------------------------------------------------------------

export function mutMove(n, u, to, cost) {
  n.pos[u] = to;
  n.flags[u] |= MOVED;
  n.ap -= cost;
}

/**
 * 攻撃を適用（n を直接変更）。occ は攻撃前の盤面の占有情報。
 * @returns {{killed:boolean, knockback:boolean, dest:number, blocked:string|null}}
 */
export function mutAttack(n, u, target, dir, occ) {
  const cfg = n.cfg;
  const T = cfg.types[cfg.unitType[u]];
  n.ap -= T.attackCost;
  n.flags[u] |= ATTACKED;
  const hit = predictHit(n, u, target, dir, occ);
  n.hp[target] -= 1;
  if (n.hp[target] <= 0) {
    n.hp[target] = 0;
    n.pos[target] = -1;
    if (cfg.unitType[target] === LEADER) {
      n.winner = cfg.unitSide[u];
      n.phase = 'over';
    } else {
      n.lost[cfg.unitSide[target]]++;
    }
    return { killed: true, knockback: false, dest: -1, blocked: null };
  }
  if (hit.dest >= 0) n.pos[target] = hit.dest;
  return { killed: false, knockback: hit.knockback, dest: hit.dest, blocked: hit.blocked };
}

// ---------------------------------------------------------------------------
// 合法手の一覧（テスト用）
// ---------------------------------------------------------------------------

export function legalActions(s) {
  if (s.phase !== 'act') return [];
  const out = [];
  for (const u of s.cfg.sideUnits[s.side]) {
    for (const m of moveOptions(s, u)) out.push({ type: 'move', unit: u, to: m.cell });
    for (const a of attackOptions(s, u)) out.push({ type: 'attack', unit: u, target: a.target });
  }
  out.push({ type: 'end' });
  return out;
}

// ---------------------------------------------------------------------------
// 表示用
// ---------------------------------------------------------------------------

/** マスの名前（列 A〜J、行は下端が 1） */
export function cellName(c, cfg) {
  return `${String.fromCharCode(65 + (c % cfg.W))}${cfg.H - ((c / cfg.W) | 0)}`;
}
