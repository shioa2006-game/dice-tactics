// DICE TACTICS — 楽器の合成（Web Audio）
// 竪琴・低音の撥弦は Karplus-Strong 法で弦の減衰を作り、弦楽・笛・枠太鼓はオシレーターとノイズで作る。
// どの関数も AudioContext / OfflineAudioContext のどちらでも動く（c = コンテキスト、out = 出力先、t = 開始時刻）。

export const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

// キャッシュ: 波形（PeriodicWave）はコンテキストごと。撥弦のバッファ・雑音はサンプルレートごとに共有する
// （AudioBuffer はどのコンテキストでも使えるので、BGM を区間に分けて書き出すときに同じ計算を繰り返さない）
const caches = new WeakMap();
function cacheOf(c) {
  let m = caches.get(c);
  if (!m) caches.set(c, (m = new Map()));
  return m;
}
const bufCaches = new Map(); // sampleRate → Map
function bufCacheOf(c) {
  let m = bufCaches.get(c.sampleRate);
  if (!m) bufCaches.set(c.sampleRate, (m = new Map()));
  return m;
}
/** あるサンプルレート用の撥弦・雑音のバッファを捨てる（BGM の書き出しが終わったあとのメモリ解放） */
export function releaseBuffers(sampleRate) {
  bufCaches.delete(sampleRate);
}

/** 決まった種から作る乱数（同じ音が毎回同じに鳴るように） */
export function seeded(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1000000) / 1000000;
  };
}

/** 白色雑音（2 秒、ループして使う） */
export function noise(c) {
  const m = bufCacheOf(c);
  if (!m.has('noise')) {
    const len = c.sampleRate * 2;
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    const r = seeded(99);
    for (let i = 0; i < len; i++) d[i] = r() * 2 - 1;
    m.set('noise', buf);
  }
  return m.get('noise');
}

/** 雑音の音源（offset で切り出し位置をずらし、毎回少し違う音にする） */
export function noiseSource(c, t, dur, offset = 0) {
  const src = c.createBufferSource();
  src.buffer = noise(c);
  src.loop = true;
  src.start(t, offset % 1.9);
  src.stop(t + dur + 0.05);
  return src;
}

/** 倍音を指定した波形（キャッシュする） */
function wave(c, name, harmonics) {
  const m = cacheOf(c);
  const key = 'wave:' + name;
  if (!m.has(key)) {
    const re = new Float32Array(harmonics.length + 1);
    const im = new Float32Array(harmonics.length + 1);
    harmonics.forEach((a, i) => (im[i + 1] = a));
    m.set(key, c.createPeriodicWave(re, im, { disableNormalization: false }));
  }
  return m.get(key);
}
const SOFT_SAW = Array.from({ length: 28 }, (_, i) => 1 / Math.pow(i + 1, 1.18));
const FLUTE = [1, 0.24, 0.09, 0.035, 0.012];
const REED_LOW = [1, 0.5, 0.33, 0.2, 0.16, 0.1, 0.07, 0.05];

/** 指数的な減衰の包絡（attack は線形） */
function env(g, t, peak, attack, decay, floor = 0.0001) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(floor, t + attack + decay);
}

function panner(c, pan, out) {
  if (!pan || !c.createStereoPanner) return out;
  const p = c.createStereoPanner();
  p.pan.value = pan;
  p.connect(out);
  return p;
}

// ---------------------------------------------------------------------------
// 撥弦（Karplus-Strong）
// ---------------------------------------------------------------------------

const PLUCK = {
  // 竪琴: 明るい立ち上がり、羊腸弦らしい少しこもった余韻（lp = 励振の低域通過 [弱く弾く, 強く弾く]）
  lyre: { t60: (m) => Math.min(3.6, Math.max(1.3, 3.3 - (m - 55) * 0.055)), lp: [0.62, 0.36], pickPos: 0.17, body: 0.22 },
  // 低音（ウードのような撥弦）: 柔らかく、長めに響く
  bass: { t60: (m) => Math.min(4.0, Math.max(2.0, 3.8 - (m - 36) * 0.06)), lp: [0.78, 0.6], pickPos: 0.12, body: 0.1 },
  // 弓の弦（効果音用）: 短く、強い
  bow: { t60: () => 0.45, lp: [0.4, 0.25], pickPos: 0.5, body: 0.3 },
};
const BRIGHT_STEPS = 4; // 強さに応じた音色の段階（0〜4）

/** 強さ → 音色の段階（0.3 以下で最も柔らかく、0.75 以上で最も明るい） */
const brightStep = (vel) => Math.round(Math.min(1, Math.max(0, (vel - 0.3) / 0.45)) * BRIGHT_STEPS);

/**
 * 撥弦の波形を作る（midi・種類・音色の段階ごとに、サンプルレート単位でキャッシュ）。
 * 整数の遅延長で作り、再生速度で正確な音程に合わせる。
 */
function pluckBuffer(c, midi, kind, step) {
  const key = `pluck:${kind}:${midi}:${step}`;
  const m = bufCacheOf(c);
  if (m.has(key)) return m.get(key);
  const P = PLUCK[kind];
  const sr = c.sampleRate;
  const f = mtof(midi);
  const exact = sr / f;
  const N = Math.max(2, Math.floor(exact));
  const t60 = P.t60(midi);
  const len = Math.min(Math.ceil(sr * (t60 + 0.25)), sr * 5);
  const buf = c.createBuffer(1, len, sr);
  const y = buf.getChannelData(0);
  const rnd = seeded(midi * 31 + step * 7 + kind.length);
  // 励振: 雑音を低域通過し、弾く位置のくし形フィルターで中空の音色にする
  const ex = new Float32Array(N);
  const a = P.lp[0] + ((P.lp[1] - P.lp[0]) * step) / BRIGHT_STEPS;
  let lp = 0;
  for (let i = 0; i < N; i++) {
    lp = lp * a + (rnd() * 2 - 1) * (1 - a);
    ex[i] = lp;
  }
  const pick = Math.max(1, Math.round(N * P.pickPos));
  for (let i = N - 1; i >= pick; i--) ex[i] -= 0.7 * ex[i - pick];
  let mean = 0;
  for (let i = 0; i < N; i++) mean += ex[i];
  mean /= N;
  // ループ: 平均化フィルター＋減衰。平均化フィルターは基音を cos(πf/sr) 倍に減らすので、その分を補って
  // 高い音でも設定どおりの余韻（t60）になるようにする
  // （ループの利得は 1 未満でないと発散するので、上限を 0.9995 にする）
  const g = Math.min(0.9995, Math.pow(10, (-3 * (N + 0.5)) / (t60 * sr)) / Math.cos((Math.PI * f) / sr));
  for (let i = 0; i < len; i++) {
    const fb = i >= N + 1 ? g * 0.5 * (y[i - N] + y[i - N - 1]) : i >= N ? g * y[i - N] : 0;
    y[i] = (i < N ? ex[i] - mean : 0) + fb;
  }
  // 指が弦に触れる小さな雑音（立ち上がりの手触り）
  const touch = Math.floor(sr * 0.006);
  for (let i = 0; i < touch && i < len; i++) y[i] += (rnd() * 2 - 1) * P.body * (1 - i / touch);
  let peak = 0;
  for (let i = 0; i < Math.min(len, sr * 0.2); i++) peak = Math.max(peak, Math.abs(y[i]));
  const norm = peak > 0 ? 0.9 / peak : 1;
  for (let i = 0; i < len; i++) y[i] *= norm;
  // バッファの終わりで音が急に切れないよう、最後の 80ms で消す
  const fade = Math.min(len, Math.floor(sr * 0.08));
  for (let i = 0; i < fade; i++) y[len - 1 - i] *= i / fade;
  // 平均化フィルターは 0.5 サンプル遅れるので、1 周期は N + 0.5 サンプル。その分も含めて音程を合わせる
  const out = { buf, rate: (N + 0.5) / exact };
  m.set(key, out);
  return out;
}

/** 撥弦の波形を前もって作っておく（最初に鳴らすときにメインスレッドで止まらないように） */
export function warmPluck(c, midi, kind, vel) {
  pluckBuffer(c, midi, kind, brightStep(vel));
}

/**
 * 撥弦の音（竪琴・低音）。dur 拍分たったら指で止める（余韻を短く切る）。
 * @param {object} o {vel, dur(秒), kind: 'lyre'|'bass'|'bow', pan, detune(セント)}
 */
export function pluck(c, out, t, midi, o = {}) {
  const vel = o.vel ?? 0.7;
  const kind = o.kind || 'lyre';
  const { buf, rate } = pluckBuffer(c, midi, kind, brightStep(vel));
  const src = c.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = rate * Math.pow(2, (o.detune || 0) / 1200);
  const g = c.createGain();
  const amp = Math.pow(vel, 1.3) * (kind === 'bass' ? 0.9 : 0.75);
  g.gain.setValueAtTime(amp, t);
  const end = t + Math.max(0.12, o.dur ?? 2);
  const natural = t + buf.duration / src.playbackRate.value;
  if (end < natural) {
    g.gain.setValueAtTime(amp, end);
    g.gain.setTargetAtTime(0, end, kind === 'bass' ? 0.09 : 0.07);
  }
  src.connect(g).connect(panner(c, o.pan, out));
  src.start(t);
  src.stop(Math.min(natural, end + 0.6));
  return src;
}

/** 竪琴の胴の響き（共鳴を少し強調）。返り値に音をつなぐ */
export function lyreBody(c, out) {
  const p1 = c.createBiquadFilter();
  p1.type = 'peaking';
  p1.frequency.value = 290;
  p1.Q.value = 1.1;
  p1.gain.value = 3;
  const p2 = c.createBiquadFilter();
  p2.type = 'peaking';
  p2.frequency.value = 2300;
  p2.Q.value = 1.3;
  p2.gain.value = 2;
  const hs = c.createBiquadFilter();
  hs.type = 'highshelf';
  hs.frequency.value = 6500;
  hs.gain.value = -5;
  p1.connect(p2).connect(hs).connect(out);
  return p1;
}

// ---------------------------------------------------------------------------
// 持続音（弦楽・笛）
// ---------------------------------------------------------------------------

/** 低音の弦楽（弓で弾く合奏）。ゆっくり立ち上がり、dur 秒保つ */
export function strings(c, out, t, midi, o = {}) {
  const vel = o.vel ?? 0.6;
  const dur = Math.max(0.3, o.dur ?? 2);
  const f = mtof(midi);
  const amp = 0.18 * Math.pow(vel, 1.1);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(amp * 0.7, t + 0.18);
  g.gain.linearRampToValueAtTime(amp, t + Math.min(0.55, dur * 0.5));
  g.gain.setValueAtTime(amp, t + dur);
  g.gain.setTargetAtTime(0.0001, t + dur, 0.28);
  const lpf = c.createBiquadFilter();
  lpf.type = 'lowpass';
  lpf.Q.value = 0.6;
  const cut = 650 + vel * 1100 + (midi - 38) * 16;
  lpf.frequency.setValueAtTime(cut * 0.7, t);
  lpf.frequency.linearRampToValueAtTime(cut, t + 0.6);
  lpf.connect(g).connect(panner(c, o.pan, out));
  // 弓の揺れ（ゆっくり遅れて始まるビブラート）
  const vib = c.createOscillator();
  vib.frequency.value = 4.6 + (midi % 5) * 0.13;
  const vibAmt = c.createGain();
  vibAmt.gain.setValueAtTime(0, t);
  vibAmt.gain.linearRampToValueAtTime(f * 0.0032, t + 0.9);
  vib.connect(vibAmt);
  const stop = t + dur + 1.6;
  for (const [cents, lvl] of [
    [-7, 0.36],
    [0, 0.4],
    [6, 0.34],
  ]) {
    const osc = c.createOscillator();
    osc.setPeriodicWave(wave(c, 'softsaw', SOFT_SAW));
    osc.frequency.value = f;
    osc.detune.value = cents;
    vibAmt.connect(osc.frequency);
    const og = c.createGain();
    og.gain.value = lvl;
    osc.connect(og).connect(lpf);
    osc.start(t);
    osc.stop(stop);
  }
  vib.start(t);
  vib.stop(stop);
}

/** 笛（ネイのような息の多い葦笛）。少し下から音程を合わせ、遅れてビブラート */
export function flute(c, out, t, midi, o = {}) {
  const vel = o.vel ?? 0.6;
  const dur = Math.max(0.15, o.dur ?? 1);
  const legato = !!o.legato; // 前の音から続けて吹く（吹き直さない）
  const tie = !!o.tieNext; // 次の音へ続ける（終わりを短く消し、次の音の立ち上がりと短く重ねてつなぐ）
  const release = tie ? 0.025 : legato ? 0.06 : 0.11;
  const f = mtof(midi);
  const amp = 0.15 * Math.pow(vel, 1.1);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(amp, t + (legato ? 0.04 : 0.085));
  // 長い音は息を少しふくらませてから収める（平坦な持続にしない）
  if (dur > 0.8) {
    g.gain.linearRampToValueAtTime(amp * 1.12, t + dur * 0.45);
    g.gain.linearRampToValueAtTime(amp * 0.92, t + dur);
  } else g.gain.setValueAtTime(amp, t + dur);
  g.gain.setTargetAtTime(0.0001, t + dur, release);
  const lpf = c.createBiquadFilter();
  lpf.type = 'lowpass';
  lpf.frequency.value = 4200;
  lpf.connect(panner(c, o.pan, out));
  g.connect(lpf);
  const osc = c.createOscillator();
  osc.setPeriodicWave(wave(c, 'flute', FLUTE));
  if (legato) osc.frequency.setValueAtTime(f, t);
  else {
    osc.frequency.setValueAtTime(f * Math.pow(2, -32 / 1200), t);
    osc.frequency.exponentialRampToValueAtTime(f, t + 0.09);
  }
  const vib = c.createOscillator();
  vib.frequency.value = 5.2;
  const vibAmt = c.createGain();
  const vibDepth = f * 0.0058;
  vibAmt.gain.setValueAtTime(legato ? vibDepth * 0.6 : 0, t);
  vibAmt.gain.setValueAtTime(legato ? vibDepth * 0.6 : 0, t + (legato ? 0.1 : 0.28));
  vibAmt.gain.linearRampToValueAtTime(vibDepth, t + 0.65);
  vib.connect(vibAmt).connect(osc.frequency);
  osc.connect(g);
  // 息の音（レガートでは吹き始めの強い息を入れない）
  const br = noiseSource(c, t, dur + 0.5, midi * 0.037);
  const bp = c.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = Math.min(3400, f * 2.1);
  bp.Q.value = 0.9;
  const bg = c.createGain();
  bg.gain.setValueAtTime(0.0001, t);
  bg.gain.linearRampToValueAtTime(amp * (legato ? 0.3 : 0.55), t + 0.04);
  bg.gain.linearRampToValueAtTime(amp * 0.22, t + 0.16);
  bg.gain.setValueAtTime(amp * 0.22, t + dur);
  bg.gain.setTargetAtTime(0.0001, t + dur, tie ? 0.025 : 0.09);
  br.connect(bp).connect(bg).connect(lpf);
  const stop = t + dur + 0.7;
  osc.start(t);
  osc.stop(stop);
  vib.start(t);
  vib.stop(stop);
}

/** 低い葦の持続音（敗北の結び・CPU 側の暗い色づけ用） */
export function reed(c, out, t, midi, o = {}) {
  const vel = o.vel ?? 0.5;
  const dur = o.dur ?? 1.5;
  const f = mtof(midi);
  const g = c.createGain();
  const amp = 0.08 * vel;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(amp, t + 0.12);
  g.gain.setValueAtTime(amp, t + dur);
  g.gain.setTargetAtTime(0.0001, t + dur, 0.2);
  const lpf = c.createBiquadFilter();
  lpf.type = 'lowpass';
  lpf.frequency.value = 1400;
  const osc = c.createOscillator();
  osc.setPeriodicWave(wave(c, 'reed', REED_LOW));
  osc.frequency.value = f;
  osc.connect(lpf).connect(g).connect(panner(c, o.pan, out));
  osc.start(t);
  osc.stop(t + dur + 1.2);
}

// ---------------------------------------------------------------------------
// 打楽器（枠太鼓・小さなシンバル）
// ---------------------------------------------------------------------------

/**
 * 枠太鼓などの一打。kind: 'dum'（中央の深い音）| 'tek'（縁の鋭い音）| 'ka'（手で押さえた柔らかい音）| 'jingle'（小さなシンバル）
 */
export function drum(c, out, t, kind, vel = 0.7, pan = 0, seedT = t) {
  const dest = panner(c, pan, out);
  // 雑音の切り出し位置は曲の中の時刻で決める（区間に分けて書き出しても同じ音になるように）
  const off = (seedT * 13.37) % 1.9;
  if (kind === 'dum') {
    // 張った皮の中央の音: 音程の下がりは小さく（電子音のキックにしない）、皮の非整数倍音を重ねる
    const o = c.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(100, t);
    o.frequency.exponentialRampToValueAtTime(78, t + 0.06);
    const g = c.createGain();
    env(g, t, 0.6 * vel, 0.004, 0.3);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + 0.4);
    for (const [r, lv, d] of [
      [1.59, 0.25, 0.18],
      [2.14, 0.15, 0.15],
    ]) {
      const o2 = c.createOscillator();
      o2.frequency.value = 100 * r;
      const g2 = c.createGain();
      env(g2, t, lv * vel, 0.003, d);
      o2.connect(g2).connect(dest);
      o2.start(t);
      o2.stop(t + d + 0.05);
    }
    // 打った瞬間の手の音
    const n = noiseSource(c, t, 0.1, off);
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    const gn = c.createGain();
    env(gn, t, 0.28 * vel, 0.002, 0.07);
    n.connect(lp).connect(gn).connect(dest);
  } else if (kind === 'tek') {
    const n = noiseSource(c, t, 0.12, off);
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 3100;
    bp.Q.value = 1.3;
    const gn = c.createGain();
    env(gn, t, 0.55 * vel, 0.001, 0.07);
    n.connect(bp).connect(gn).connect(dest);
    const o = c.createOscillator();
    o.frequency.setValueAtTime(780, t);
    o.frequency.exponentialRampToValueAtTime(690, t + 0.06);
    const g = c.createGain();
    env(g, t, 0.17 * vel, 0.001, 0.1);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + 0.15);
  } else if (kind === 'ka') {
    // 手で押さえた軽い音（ゴースト打）。小さくても聞き取れるよう、中域を少し強める
    const n = noiseSource(c, t, 0.08, off);
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1600;
    bp.Q.value = 1.2;
    const gn = c.createGain();
    env(gn, t, 1.2 * vel, 0.001, 0.045);
    n.connect(bp).connect(gn).connect(dest);
    const o = c.createOscillator();
    o.frequency.setValueAtTime(240, t);
    o.frequency.exponentialRampToValueAtTime(200, t + 0.05);
    const g = c.createGain();
    env(g, t, 0.2 * vel, 0.002, 0.07);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + 0.12);
  } else if (kind === 'jingle') {
    // 小さなシンバル（シストラム）: 数回の細かい揺れ＋金属の非整数倍音
    for (const [dt, lv] of [
      [0, 1],
      [0.018, 0.6],
      [0.043, 0.4],
    ]) {
      const n = noiseSource(c, t + dt, 0.2, off + dt);
      const hp = c.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 5600;
      const gn = c.createGain();
      env(gn, t + dt, 0.13 * vel * lv, 0.001, 0.13);
      n.connect(hp).connect(gn).connect(dest);
    }
    for (const [fq, lv] of [
      [3170, 1],
      [4490, 0.8],
      [6260, 0.6],
      [7730, 0.45],
    ]) {
      const o = c.createOscillator();
      o.frequency.value = fq;
      const g = c.createGain();
      env(g, t, 0.028 * vel * lv, 0.002, 0.42);
      o.connect(g).connect(dest);
      o.start(t);
      o.stop(t + 0.5);
    }
  }
}

// ---------------------------------------------------------------------------
// 音楽用のミキサー（BGM の書き出し・ジングルで共通）
// ---------------------------------------------------------------------------

/**
 * 楽器ごとの入力（音量・定位・残響の送り）をまとめて作る。
 * @returns {{lyre, bass, strings, flute, reed, drums}} 各楽器の入力ノード
 */
export function musicMix(c, out, impulse) {
  const verb = c.createConvolver();
  verb.buffer = impulse;
  const wet = c.createGain();
  wet.gain.value = 0.9;
  verb.connect(wet).connect(out);
  const bus = (gain, send, pre) => {
    const g = c.createGain();
    g.gain.value = gain;
    g.connect(out);
    const s = c.createGain();
    s.gain.value = send;
    g.connect(s).connect(verb);
    return pre ? pre(g) : g;
  };
  return {
    lyre: bus(0.95, 0.3, (g) => lyreBody(c, g)),
    bass: bus(0.85, 0.14),
    strings: bus(0.8, 0.36),
    flute: bus(0.62, 0.34),
    reed: bus(0.7, 0.3),
    drums: bus(0.62, 0.17),
  };
}

/** 楽譜の 1 音を鳴らす（i = 楽器 id、時間は秒） */
export function playNote(c, mix, n, t, dur) {
  const o = { vel: n.v, dur, pan: n.pan ?? 0, legato: !!n.legato, tieNext: !!n.tieNext };
  if (n.i === 'lyre') pluck(c, mix.lyre, t, n.m, { ...o, kind: 'lyre' });
  else if (n.i === 'bass') pluck(c, mix.bass, t, n.m, { ...o, kind: 'bass' });
  else if (n.i === 'strings') strings(c, mix.strings, t, n.m, o);
  else if (n.i === 'flute') flute(c, mix.flute, t, n.m, o);
  else if (n.i === 'reed') reed(c, mix.reed, t, n.m, o);
}
