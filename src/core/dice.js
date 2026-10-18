// DICE TACTICS 基本形 — 被害連動ダイス
//
// 毎ターン「基本 1AP ＋ ダイス 3 個の出目の合計」を得る。各ダイスは 0〜最大値の整数を等確率で出す。
// 自軍のリーダー以外のユニットを失うたびに、ダイスの最大値が段階的に上がる（強化段階 ▲0〜▲3）。
//
//   累計喪失数   ダイスの最大値   AP の範囲   平均
//   ▲0（0 体）   2・2・2          1〜7        4.0
//   ▲1（1 体）   3・2・2          1〜8        4.5
//   ▲2（2 体）   3・3・2          1〜9        5.0
//   ▲3（3 体〜） 3・3・3          1〜10       5.5
//
// 確率分布はここで正確に計算し、ゲーム本体・CPU の評価・テスト・UI で共通に使う。

export const BASE_AP = 1;
export const DICE_STAGES = [
  [2, 2, 2],
  [3, 2, 2],
  [3, 3, 2],
  [3, 3, 3],
];

/** 累計喪失数 → 強化段階（0〜3 で頭打ち） */
export function stageOf(lost) {
  return Math.max(0, Math.min(lost | 0, DICE_STAGES.length - 1));
}

/** 累計喪失数に応じた各ダイスの最大値 */
export function diceMaxes(lost = 0) {
  return DICE_STAGES[stageOf(lost)].slice();
}

/**
 * 各ダイスが 0〜max の一様分布のとき、出目の合計の場合の数。
 * @returns {{counts: number[], total: number}} counts[k] = 合計 k になる場合の数、total = 全場合の数
 */
export function sumCounts(maxes) {
  let counts = [1];
  let total = 1;
  for (const m of maxes) {
    const next = new Array(counts.length + m).fill(0);
    for (let k = 0; k < counts.length; k++) for (let f = 0; f <= m; f++) next[k + f] += counts[k];
    counts = next;
    total *= m + 1;
  }
  return { counts, total };
}

const distCache = new Map();
/** 次に獲得する AP の確率分布 [[ap, prob], ...]（ap の昇順） */
export function apDistribution(lost = 0) {
  const st = stageOf(lost);
  let d = distCache.get(st);
  if (!d) {
    const { counts, total } = sumCounts(DICE_STAGES[st]);
    d = counts.map((c, k) => [BASE_AP + k, c / total]).filter(([, p]) => p > 0);
    distCache.set(st, d);
  }
  return d;
}

/** 次に獲得しうる AP の最大値 */
export function maxAP(lost = 0) {
  return BASE_AP + diceMaxes(lost).reduce((a, b) => a + b, 0);
}

/** AP の期待値 */
export function meanAP(dist) {
  let e = 0;
  for (const [ap, p] of dist) e += ap * p;
  return e;
}

/** ダイスを振る。各ダイスは 0〜max の整数を等確率で出す */
export function rollDice(rng, maxes) {
  const d = [];
  for (let i = 0; i < maxes.length; i++) d.push(Math.floor(rng() * (maxes[i] + 1)));
  return d;
}
