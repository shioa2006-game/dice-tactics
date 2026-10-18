// DICE TACTICS 基本形 — 盤面・ユニット・ルールの定数
// 10×10 の盤面、各陣営 6 体（リーダー・戦士×2・弓使い×2・魔法使い）。
// ルール判定（rules.js）・CPU（ai.js）・UI はすべて makeConfig() が作る cfg を参照する。

export const HUMAN = 0; // 人間族（プレイヤー、盤面の下側）
export const MONSTER = 1; // モンスター族（CPU、盤面の上側）
export const SIDE_NAMES = ['人間族', 'モンスター族'];

// 職業
export const LEADER = 0;
export const WARRIOR = 1;
export const ARCHER = 2;
export const MAGE = 3;

// ターン内の行動フラグ
export const MOVED = 1;
export const ATTACKED = 2;

// 上・右・下・左
export const DIRS = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

export const UNIT_TYPES = [
  { key: 'leader', name: 'リーダー', short: '王', hp: 4, minRange: 1, maxRange: 1, attackCost: 1, obstacleBlocks: true, knockback: false },
  { key: 'warrior', name: '戦士', short: '戦', hp: 3, minRange: 1, maxRange: 1, attackCost: 1, obstacleBlocks: true, knockback: false },
  { key: 'archer', name: '弓使い', short: '弓', hp: 2, minRange: 2, maxRange: 4, attackCost: 2, obstacleBlocks: true, knockback: true },
  { key: 'mage', name: '魔法使い', short: '魔', hp: 2, minRange: 1, maxRange: 2, attackCost: 2, obstacleBlocks: false, knockback: false },
];

// 各陣営のユニットの並び。ユニット番号 = 陣営 × 6 ＋ 並び順
export const ROSTER = [LEADER, WARRIOR, WARRIOR, ARCHER, ARCHER, MAGE];

export const RULES = {
  moveCost: 1, // 1 マスの移動に必要な AP
  maxRounds: 40, // このラウンドが終わると引き分け
};

// 標準の初期配置（点対称）。人間族の配置と岩の半分だけを書き、残りは (x, y) → (9 - x, 9 - y) で作る。
// 人間族: [王, 戦1, 戦2, 弓1, 弓2, 魔]。y = 0 が上端。
const BOARD_W = 10;
const BOARD_H = 10;
const HUMAN_START = [
  [4, 8],
  [3, 7],
  [6, 7],
  [2, 8],
  [7, 8],
  [5, 8],
];
const ROCKS_HALF = [
  [2, 4],
  [4, 5],
];

const sym = (p) => [BOARD_W - 1 - p[0], BOARD_H - 1 - p[1]];
/** 標準の配置: rocks = 岩のマス [[x, y], ...]、start[陣営][並び順] = [x, y]（null なら撃破済み扱い） */
export const STANDARD_LAYOUT = {
  rocks: ROCKS_HALF.flatMap((r) => [r, sym(r)]),
  start: [HUMAN_START, HUMAN_START.map(sym)],
};

/**
 * 盤面・ユニット構成と、CPU が使う距離テーブルをまとめた設定を作る。
 * layout を省略すると標準の配置（テストでは任意の配置を渡せる）。
 */
export function makeConfig(layout = STANDARD_LAYOUT) {
  const W = BOARD_W;
  const H = BOARD_H;
  const N = W * H;
  const rocks = layout.rocks;
  const startXY = layout.start;

  const perSide = ROSTER.length;
  const unitCount = perSide * 2;
  const unitType = new Int8Array(unitCount);
  const unitSide = new Int8Array(unitCount);
  const unitNo = new Int8Array(unitCount); // 同じ職業が複数いる場合の番号（1 始まり）。1 体だけなら 0
  const sideUnits = [[], []];
  const leaderOf = [-1, -1];
  for (let side = 0; side < 2; side++) {
    for (let k = 0; k < perSide; k++) {
      const u = side * perSide + k;
      unitType[u] = ROSTER[k];
      unitSide[u] = side;
      sideUnits[side].push(u);
      if (ROSTER[k] === LEADER) leaderOf[side] = u;
      const same = ROSTER.filter((t) => t === ROSTER[k]).length;
      unitNo[u] = same > 1 ? ROSTER.slice(0, k + 1).filter((t) => t === ROSTER[k]).length : 0;
    }
  }

  const cellXY = (x, y) => y * W + x;
  const inside = (x, y) => x >= 0 && y >= 0 && x < W && y < H;
  const obstacle = new Uint8Array(N);
  for (const [x, y] of rocks) obstacle[cellXY(x, y)] = 1;

  const neighbors = [];
  for (let c = 0; c < N; c++) {
    const x = c % W;
    const y = (c / W) | 0;
    const list = [];
    for (const [dx, dy] of DIRS) {
      if (inside(x + dx, y + dy)) list.push(cellXY(x + dx, y + dy));
    }
    neighbors.push(list);
  }

  // 静的距離（障害物のみ考慮、ユニットは無視）: sdist[a * N + b]
  const sdist = new Int8Array(N * N).fill(-1);
  for (let a = 0; a < N; a++) {
    if (obstacle[a]) continue;
    const q = [a];
    sdist[a * N + a] = 0;
    for (let qi = 0; qi < q.length; qi++) {
      const c = q[qi];
      const d = sdist[a * N + c];
      for (const n of neighbors[c]) {
        if (obstacle[n] || sdist[a * N + n] >= 0) continue;
        sdist[a * N + n] = d + 1;
        q.push(n);
      }
    }
  }

  // 静的攻撃距離: atkDist[職業][from * N + target] = from から target を攻撃できるマスまでの最短移動数（CPU 用）
  const atkDist = [];
  for (let t = 0; t < UNIT_TYPES.length; t++) {
    const T = UNIT_TYPES[t];
    const table = new Int8Array(N * N).fill(99);
    for (let target = 0; target < N; target++) {
      if (obstacle[target]) continue;
      const spots = staticAttackSpots(T, target, obstacle, W, H);
      for (let from = 0; from < N; from++) {
        if (obstacle[from]) continue;
        let best = 99;
        for (const p of spots) {
          const d = sdist[from * N + p];
          if (d >= 0 && d < best) best = d;
        }
        table[from * N + target] = best;
      }
    }
    atkDist.push(table);
  }

  return {
    W,
    H,
    CELLS: N,
    dmax: W + H - 2, // 位置評価で使う「遠さ」の上限
    roster: ROSTER,
    perSide,
    unitCount,
    unitType,
    unitSide,
    unitNo,
    sideUnits,
    leaderOf,
    types: UNIT_TYPES,
    rules: RULES,
    obstacle,
    neighbors,
    start: startXY.map((side) => side.map((p) => (p ? cellXY(p[0], p[1]) : -1))),
    sdist,
    atkDist,
  };
}

// 障害物だけを考慮した「target を攻撃できる位置」
function staticAttackSpots(T, target, obstacle, W, H) {
  const spots = [];
  const tx = target % W;
  const ty = (target / W) | 0;
  for (const [dx, dy] of DIRS) {
    let x = tx;
    let y = ty;
    for (let k = 1; k <= T.maxRange; k++) {
      x += dx;
      y += dy;
      if (x < 0 || y < 0 || x >= W || y >= H) break;
      const c = y * W + x;
      if (obstacle[c]) {
        if (T.obstacleBlocks) break;
        continue;
      }
      if (k >= T.minRange) spots.push(c);
    }
  }
  return spots;
}

/** ユニットの表示名（同じ職業が複数いる場合は番号付き: 戦士1） */
export function unitName(cfg, u) {
  const t = cfg.types[cfg.unitType[u]];
  return cfg.unitNo[u] ? `${t.name}${cfg.unitNo[u]}` : t.name;
}

/** ユニットの短い表示名（王・戦1・弓2 など） */
export function unitShort(cfg, u) {
  const t = cfg.types[cfg.unitType[u]];
  return cfg.unitNo[u] ? `${t.short}${cfg.unitNo[u]}` : t.short;
}
