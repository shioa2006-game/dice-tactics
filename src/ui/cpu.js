// DICE TACTICS 基本形 — CPU の呼び出し
// 思考は Web Worker（cpu-worker.js）で行い、UI を止めない。Worker が使えない環境ではメインスレッドで実行する。
// Worker へは難易度のキー（文字列）だけを送り、設定は Worker 側で src/core/levels.js から引く。

import { planLevel } from '../core/levels.js';
import { makeRng, randomSeed } from '../core/rng.js';

let worker = null; // null = 未作成、false = 使えない
let seq = 0;
const pending = new Map();

const planHere = (p) => planLevel(p.state, { level: p.level, rng: makeRng(p.seed), prevStart: p.prevStart, persona: p.persona });

function getWorker() {
  if (worker !== null) return worker;
  try {
    worker = new Worker(new URL('./cpu-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.error) {
        console.error('CPU worker error:', e.data.error);
        p.resolve(planHere(p));
      } else p.resolve(e.data.res);
    };
    worker.onerror = (e) => {
      console.error('CPU worker を使えないため、メインスレッドで思考します', e.message);
      worker = false;
      for (const [id, p] of pending) {
        pending.delete(id);
        p.resolve(planHere(p));
      }
    };
  } catch {
    worker = false;
  }
  return worker;
}

/**
 * 手番の陣営（state.side）の行動計画を求める。
 * @param {object} state
 * @param {{level?: string, prevStart?: number[], persona?: string|null}} opts
 *   level = 難易度のキー、prevStart = 前のターンの開始時の駒の位置、persona = やさしいの性格のキー
 * @returns {Promise<{actions: object[], info: object}>}
 */
export function requestPlan(state, { level, prevStart, persona } = {}) {
  const seed = randomSeed();
  const p = { state, seed, level, prevStart, persona };
  const w = getWorker();
  if (!w) return new Promise((resolve) => setTimeout(() => resolve(planHere(p)), 0));
  return new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, { resolve, ...p });
    w.postMessage({ id, ...p });
  });
}
