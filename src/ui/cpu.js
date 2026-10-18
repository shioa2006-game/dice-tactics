// DICE TACTICS 基本形 — CPU の呼び出し
// 思考は Web Worker（cpu-worker.js）で行い、UI を止めない。Worker が使えない環境ではメインスレッドで実行する。

import { planTurn } from '../core/ai.js';
import { makeRng, randomSeed } from '../core/rng.js';

let worker = null; // null = 未作成、false = 使えない
let seq = 0;
const pending = new Map();

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
        p.resolve(planTurn(p.state, { rng: makeRng(p.seed) }));
      } else p.resolve(e.data.res);
    };
    worker.onerror = (e) => {
      console.error('CPU worker を使えないため、メインスレッドで思考します', e.message);
      worker = false;
      for (const [id, p] of pending) {
        pending.delete(id);
        p.resolve(planTurn(p.state, { rng: makeRng(p.seed) }));
      }
    };
  } catch {
    worker = false;
  }
  return worker;
}

/**
 * 手番の陣営（state.side）の行動計画を求める。
 * @returns {Promise<{actions: object[], info: object}>}
 */
export function requestPlan(state) {
  const seed = randomSeed();
  const w = getWorker();
  if (!w) return new Promise((resolve) => setTimeout(() => resolve(planTurn(state, { rng: makeRng(seed) })), 0));
  return new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, { resolve, state, seed });
    w.postMessage({ id, state, seed });
  });
}
