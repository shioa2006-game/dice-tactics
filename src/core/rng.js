// シード付き乱数（mulberry32）。テストと CPU のばらつきの再現に使う。
export function makeRng(seed) {
  let a = seed >>> 0;
  const rng = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.seed = seed >>> 0;
  return rng;
}

export function randomSeed() {
  return (Math.random() * 4294967296) >>> 0;
}
