// DICE TACTICS — 音の土台
// AudioContext・音量のバス（効果音 / BGM / ジングル）・残響・ダッキング（効果音の間だけ BGM を下げる）・設定の保存。
// ブラウザの自動再生の制限があるため、AudioContext は最初の操作のときに作り、操作のたびに必要なら再開する（unlock）。
// タッチ端末では pointerdown では再生が許可されないので、touchend / click などでも unlock を呼ぶ（app.js）。
// 背景タブ・消音中・効果音も BGM もオフのときは AudioContext を止め、音を鳴らさない。

const STORE_KEY = 'dice-tactics.audio';
const DEFAULTS = { sfx: true, sfxVol: 0.8, bgm: false, bgmVol: 0.55, mute: false };

export const settings = loadSettings();

let ctx = null;
let master = null; // 全体の音量（消音もここ）
let sfxBus = null; // 効果音
let musicBus = null; // BGM の音量
let duckGain = null; // ダッキング用
let stingerBus = null; // ジングル（ダッキングを受けない）
let reverbIn = null; // 残響への送り
let unlocked = false;
let failed = false; // Web Audio が使えない（一度失敗したらやり直さない）
const unlockListeners = [];

let resuming = false; // ユーザー操作の中で再開を頼んだ直後（state が running になるのは非同期）
let suspendTimer = 0;

/** AudioContext を作り終えたか（実際に鳴っているかは running() で見る） */
export const ready = () => !!ctx && unlocked;
/** 音が流れている（または操作の中で再開を頼んだ直後の）状態か */
export const running = () => !!ctx && (ctx.state === 'running' || resuming);
export const unavailable = () => failed;
export const context = () => ctx;
export const sfxOut = () => sfxBus;
export const musicOut = () => musicBus;
export const stingerOut = () => stingerBus;
export const reverbSend = () => reverbIn;
/** 効果音を鳴らしてよいか */
export const sfxEnabled = () => running() && unlocked && settings.sfx && !settings.mute;
/** ジングルを鳴らしてよいか（効果音か BGM のどちらかがオンなら鳴らす） */
export const stingerEnabled = () => running() && unlocked && !settings.mute && (settings.sfx || settings.bgm);
/** AudioContext を動かしておく必要があるか */
const wantsRunning = () => !settings.mute && (settings.sfx || settings.bgm);

/** unlock されたときに呼ぶ処理を登録する（BGM の開始など） */
export function onUnlock(fn) {
  if (unlocked) fn();
  else unlockListeners.push(fn);
}

/**
 * ユーザー操作のたびに呼ぶ。AudioContext がなければ作り、止まっていれば再開する。
 * 再開はブラウザに拒否されることがある（タッチの pointerdown など）ので、結果は state で確かめる。
 */
export function unlock() {
  if (failed) return;
  if (!ctx) {
    try {
      build();
    } catch (err) {
      failed = true;
      console.error('音を使えません:', err);
      return;
    }
  }
  if (!unlocked) {
    unlocked = true;
    for (const fn of unlockListeners.splice(0)) fn();
  }
  syncRunning();
}

/**
 * AudioContext を、鳴らす音があるときは動かし、ないとき（消音・効果音も BGM もオフ）は止める。
 * 再開はすぐに（ユーザー操作の中で）頼む。停止はフェードアウトや余韻が終わってから行う
 * （すぐ止めると音が途中で凍り、再開したときに続きが鳴ってしまう）。
 */
function syncRunning() {
  clearTimeout(suspendTimer);
  if (!ctx || ctx.state === 'closed' || !unlocked || document.hidden) return;
  if (wantsRunning()) {
    if (ctx.state !== 'running') resume();
    return;
  }
  suspendTimer = setTimeout(() => {
    if (ctx.state === 'running' && !wantsRunning() && !document.hidden) Promise.resolve(ctx.suspend()).catch(() => {});
  }, 1200);
}

function resume() {
  try {
    resuming = true;
    Promise.resolve(ctx.resume())
      .catch(() => {})
      .finally(() => (resuming = false));
  } catch {
    resuming = false;
  }
}

/** グラフはすべて組み終えてからモジュールの変数に入れる（途中で失敗しても半端な状態を残さない） */
function build() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) throw new Error('Web Audio に対応していません');
  const c = new AC({ latencyHint: 'interactive' });
  try {
    // 最後に、音が重なって割れそうなときだけ効くリミッター（BGM だけのときは効かない高さにして、BGM を揺らさない）
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -6;
    comp.knee.value = 4;
    comp.ratio.value = 8;
    comp.attack.value = 0.003;
    comp.release.value = 0.15;
    const m = c.createGain();
    m.connect(comp).connect(c.destination);
    const sfx = c.createGain();
    sfx.connect(m);
    const music = c.createGain();
    const duck = c.createGain();
    music.connect(duck).connect(m);
    const sting = c.createGain();
    sting.connect(m);
    // 効果音用の短い残響（石造りの広間）
    const conv = c.createConvolver();
    conv.buffer = makeImpulse(c, 1.6, 2.6);
    const wet = c.createGain();
    wet.gain.value = 0.5;
    const rv = c.createGain();
    rv.connect(conv).connect(wet).connect(sfx);
    [ctx, master, sfxBus, musicBus, duckGain, stingerBus, reverbIn] = [c, m, sfx, music, duck, sting, rv];
  } catch (err) {
    Promise.resolve(c.close && c.close()).catch(() => {});
    throw err;
  }
  applyVolumes();
  document.addEventListener('visibilitychange', () => {
    if (!ctx || ctx.state === 'closed') return;
    if (document.hidden) {
      clearTimeout(suspendTimer);
      Promise.resolve(ctx.suspend()).catch(() => {});
    } else syncRunning();
  });
}

const impulseCache = new Map(); // `${sampleRate}:${seconds}:${decay}:${seed}` → Float32Array[2]
/**
 * 残響のインパルス応答（指数減衰するステレオのノイズ。高域ほど早く減衰させる）。
 * OfflineAudioContext でも使えるように c を受け取る。波形はサンプルレートごとに一度だけ計算する。
 */
export function makeImpulse(c, seconds, decay, seed = 7) {
  const key = `${c.sampleRate}:${seconds}:${decay}:${seed}`;
  let data = impulseCache.get(key);
  if (!data) {
    const len = Math.floor(c.sampleRate * seconds);
    let s = seed;
    const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
    data = [0, 1].map(() => {
      const d = new Float32Array(len);
      let lp = 0;
      const pre = Math.floor(c.sampleRate * 0.012);
      for (let i = pre; i < len; i++) {
        const t = (i - pre) / c.sampleRate;
        // 時間とともに暗くなる（一次の低域通過の係数を上げていく）
        const k = Math.min(0.92, 0.25 + t * 0.45);
        lp = lp * k + rnd() * (1 - k);
        d[i] = lp * Math.pow(1 - t / seconds, decay) * 1.6;
      }
      return d;
    });
    impulseCache.set(key, data);
  }
  const buf = c.createBuffer(2, data[0].length, c.sampleRate);
  buf.getChannelData(0).set(data[0]);
  buf.getChannelData(1).set(data[1]);
  return buf;
}

/** あるサンプルレート用の残響の波形を捨てる（BGM の書き出しが終わったあとのメモリ解放） */
export function releaseImpulses(sampleRate) {
  for (const k of [...impulseCache.keys()]) if (k.startsWith(sampleRate + ':')) impulseCache.delete(k);
}

// ---------------------------------------------------------------------------
// 音量・ダッキング
// ---------------------------------------------------------------------------

export function applyVolumes() {
  if (!ctx) return;
  const now = ctx.currentTime;
  master.gain.setTargetAtTime(settings.mute ? 0 : 1, now, 0.03);
  sfxBus.gain.setTargetAtTime(settings.sfx ? settings.sfxVol : 0, now, 0.03);
  musicBus.gain.setTargetAtTime(settings.bgmVol * 0.62, now, 0.05);
  // ジングル: 効果音がオンなら効果音の音量、効果音オフ・BGM オンなら BGM の音量に合わせる
  stingerBus.gain.setTargetAtTime(settings.sfx ? settings.sfxVol : settings.bgm ? Math.min(1, settings.bgmVol * 1.1) : 0, now, 0.03);
  // 鳴らす音がないときは止めて電池を節約する（ここはクリック・変更のイベントの中なので再開も許可される）
  syncRunning();
}

let duckUntil = 0;
/**
 * 効果音が鳴る間だけ BGM を下げる（depth = 下げた後の倍率、ms = 下げておく時間）。
 * 連続攻撃でも上下に揺れすぎないよう、下げている間に呼ばれたら延長だけする。
 */
export function duck(depth = 0.7, ms = 380) {
  if (!ctx || !duckGain) return;
  const now = ctx.currentTime;
  const g = duckGain.gain;
  // 予定済みの「戻す」をいったん取り消し、今の値から下げ直して、戻す時刻を延長する
  g.cancelScheduledValues(now);
  g.setValueAtTime(g.value, now);
  g.setTargetAtTime(Math.min(depth, g.value), now, 0.025);
  duckUntil = Math.max(duckUntil, now + ms / 1000);
  g.setTargetAtTime(1, duckUntil, 0.28);
}

/** ダッキングをすぐに戻す（ジングルを途中で止めたときなど） */
export function unduck() {
  if (!ctx || !duckGain) return;
  const now = ctx.currentTime;
  const g = duckGain.gain;
  g.cancelScheduledValues(now);
  g.setValueAtTime(g.value, now);
  g.setTargetAtTime(1, now, 0.15);
  duckUntil = now;
}

// ---------------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------------

function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORE_KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(settings));
  } catch {
    // 保存できない環境では、このページを開いている間だけ有効
  }
}
