// CPU 思考用の Web Worker。UI をブロックせずに、難易度に応じた行動計画を立てる。
import { planLevel } from '../core/levels.js';
import { makeRng } from '../core/rng.js';

self.onmessage = (e) => {
  const { id, state, seed, level, prevStart, persona } = e.data;
  try {
    const res = planLevel(state, { level, rng: makeRng(seed), prevStart, persona });
    self.postMessage({ id, res });
  } catch (err) {
    self.postMessage({ id, error: String(err && err.stack ? err.stack : err) });
  }
};
