// CPU 思考用の Web Worker。UI をブロックせずに planTurn を実行する。
import { planTurn } from '../core/ai.js';
import { makeRng } from '../core/rng.js';

self.onmessage = (e) => {
  const { id, state, seed } = e.data;
  try {
    const res = planTurn(state, { rng: makeRng(seed) });
    self.postMessage({ id, res });
  } catch (err) {
    self.postMessage({ id, error: String(err && err.stack ? err.stack : err) });
  }
};
