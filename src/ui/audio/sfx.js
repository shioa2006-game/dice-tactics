// DICE TACTICS — 効果音
// 素材のイメージ: 陶器のダイス、木と石の駒、青銅の剣、弓の弦、魔法は鈴のきらめき。
// CPU（モンスター族）側は同じ行動でも少し低く暗い音にして、音だけでもどちらの行動か分かるようにする。
// どの音も演出（fx.js）・進行（app.js）から呼ぶだけで、ゲームの結果は決めない。音を消しても情報は失われない。

import { HUMAN } from '../../core/config.js';
import * as E from './engine.js';
import * as SCORE from './score.js';
import { pluck, lyreBody, drum, noiseSource, seeded } from './instruments.js';
import { playStinger, warmStingers } from './render.js';
import * as Music from './music.js';

const last = new Map(); // 同じ音を短い間に重ねすぎない
function allow(name, gapMs) {
  const c = E.context();
  const now = c.currentTime;
  if (now - (last.get(name) ?? -1) < gapMs / 1000) return false;
  last.set(name, now);
  return true;
}

const liveBuses = new Set(); // 鳴っている（予約済みの）効果音の出口。新しいゲームで一斉に消す

/** 効果音の出口（dry = そのまま、wet = 残響への送り） */
function bus(dry = 1, wet = 0.15) {
  const c = E.context();
  const g = c.createGain();
  g.gain.value = dry;
  g.connect(E.sfxOut());
  if (wet > 0) {
    const s = c.createGain();
    s.gain.value = wet;
    g.connect(s).connect(E.reverbSend());
  }
  liveBuses.add(g);
  setTimeout(() => {
    g.disconnect();
    liveBuses.delete(g);
  }, 4000);
  return g;
}

/** 予約済みの効果音をすべて消す（新しいゲームで、前の対局の足音などが残らないように） */
export function silenceAll(fade = 0.05) {
  const c = E.context();
  if (!c) return;
  const t = c.currentTime;
  for (const g of liveBuses) {
    g.gain.cancelScheduledValues(t);
    g.gain.setValueAtTime(g.gain.value, t);
    g.gain.setTargetAtTime(0, t, fade / 3);
  }
  liveBuses.clear();
}

function tone(out, t, type, f0, f1, peak, attack, decay) {
  const c = E.context();
  const o = c.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + attack + decay * 0.6);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  o.connect(g).connect(out);
  o.start(t);
  o.stop(t + attack + decay + 0.05);
}

function hiss(out, t, filterType, freq, q, peak, attack, decay, freqTo) {
  const c = E.context();
  const n = noiseSource(c, t, attack + decay + 0.05, (t * 7.1) % 1.9);
  const f = c.createBiquadFilter();
  f.type = filterType;
  f.frequency.setValueAtTime(freq, t);
  if (freqTo) f.frequency.exponentialRampToValueAtTime(freqTo, t + attack + decay);
  f.Q.value = q;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  n.connect(f).connect(g).connect(out);
}

const sideK = (side) => (side === HUMAN ? 1 : 0.82); // CPU 側は少し低く
const now = (dt = 0) => E.context().currentTime + 0.01 + dt;

// ---------------------------------------------------------------------------
// 操作
// ---------------------------------------------------------------------------

/** 毎回少しだけ音程・強さを変える（同じ音の連打を機械的に聞かせない） */
const varySeed = seeded(17);
const vary = (x, amount = 0.03) => x * (1 - amount + varySeed() * amount * 2);

/** 木の駒を軽く叩く（駒の選択） */
export function select() {
  if (!E.sfxEnabled() || !allow('select', 40)) return;
  const o = bus(0.9, 0.08);
  const t = now();
  tone(o, t, 'sine', vary(560), vary(430), 0.32, 0.002, 0.07);
  hiss(o, t, 'bandpass', 2600, 1.4, 0.08, 0.001, 0.025);
}

/** プレビュー（移動先 = 軽い「カチ」、攻撃 = 少し緊張感のある 2 音） */
export function preview(kind) {
  if (!E.sfxEnabled() || !allow('preview', 40)) return;
  const o = bus(0.8, 0.06);
  const t = now();
  if (kind === 'attack') {
    tone(o, t, 'triangle', 740, 740, 0.12, 0.002, 0.05);
    tone(o, t + 0.06, 'triangle', 698, 698, 0.12, 0.002, 0.07);
  } else {
    tone(o, t, 'sine', 980, 900, 0.16, 0.002, 0.04);
  }
}

/** 無効な操作（こもった低い音。不快にならない程度） */
export function error() {
  if (!E.sfxEnabled() || !allow('error', 120)) return;
  const o = bus(0.9, 0.04);
  const t = now();
  tone(o, t, 'sine', 170, 120, 0.3, 0.003, 0.12);
  hiss(o, t, 'lowpass', 400, 0.7, 0.1, 0.002, 0.06);
}

/** 移動を戻す（駒が滑って戻る） */
export function undo() {
  if (!E.sfxEnabled()) return;
  const o = bus(0.8, 0.1);
  const t = now();
  hiss(o, t, 'bandpass', 600, 0.9, 0.12, 0.12, 0.08, 1500);
  tone(o, t + 0.17, 'sine', 300, 240, 0.18, 0.002, 0.05);
}

/** ターン終了の確認待ち（注意を促す短い 2 音） */
export function armed() {
  if (!E.sfxEnabled()) return;
  const o = bus(0.7, 0.05);
  const t = now();
  tone(o, t, 'sine', 700, 700, 0.12, 0.002, 0.05);
  tone(o, t + 0.09, 'sine', 700, 700, 0.12, 0.002, 0.05);
}

/** 手番の開始（あなた = 柔らかい鐘、CPU = 低い太鼓 1 打） */
export function turn(side) {
  if (!E.sfxEnabled()) return;
  const t = now(0.02);
  if (side === HUMAN) {
    const o = bus(0.6, 0.35);
    const f = 587.33; // D5
    for (const [r, lv, d] of [
      [1, 0.12, 1.4],
      [2, 0.05, 0.9],
      [2.76, 0.035, 0.6],
      [5.4, 0.015, 0.3],
    ])
      tone(o, t, 'sine', f * r, f * r, lv, 0.004, d);
  } else {
    drum(E.context(), bus(0.75, 0.2), t, 'dum', 0.5);
  }
}

/** 新しいゲーム（駒を盤に並べる） */
export function newGame() {
  if (!E.sfxEnabled()) return;
  const o = bus(0.8, 0.12);
  const r = seeded(3);
  for (let i = 0; i < 6; i++) {
    const t = now(i * 0.06 + r() * 0.02);
    tone(o, t, 'sine', 420 + r() * 160, 330, 0.18, 0.002, 0.06);
    hiss(o, t, 'bandpass', 2200, 1.2, 0.05, 0.001, 0.02);
  }
}

// ---------------------------------------------------------------------------
// ダイス
// ---------------------------------------------------------------------------

/** 陶器のダイスが器の中で鳴る（sec 秒のあいだ） */
export function diceRoll(sec) {
  if (!E.sfxEnabled()) return;
  const o = bus(0.75, 0.1);
  const r = seeded(Math.floor(E.context().currentTime * 1000));
  let t = 0;
  while (t < sec) {
    const at = now(t);
    hiss(o, at, 'bandpass', 2400 + r() * 1800, 2.2, 0.1 + r() * 0.08, 0.001, 0.018);
    if (r() < 0.4) tone(o, at, 'sine', 900 + r() * 500, 800, 0.05, 0.001, 0.025);
    t += 0.045 + r() * 0.05;
  }
}

/** 出目が決まる（3 個が少しずつずれて止まる）。強化されたダイスが最大の目なら澄んだ響きを足す */
export function diceLand(values, maxes) {
  if (!E.sfxEnabled()) return;
  E.duck(0.85, 250);
  const o = bus(0.9, 0.14);
  values.forEach((v, i) => {
    const t = now(i * 0.07);
    tone(o, t, 'sine', 860 - i * 40, 720, 0.22, 0.002, 0.05);
    hiss(o, t, 'bandpass', 2100, 1.5, 0.12, 0.001, 0.035);
    if (maxes[i] >= 3 && v === maxes[i]) tone(bus(0.6, 0.4), t + 0.02, 'sine', 1760, 1760, 0.05, 0.003, 0.5);
  });
}

/** AP が多いときの竪琴の短い上昇音（主題の頭を速く弾く） */
export function highAP() {
  if (!E.sfxEnabled()) return;
  const c = E.context();
  const o = lyreBody(c, bus(0.85, 0.3));
  // 主題の頭（A–D–E–F）を、その音の高さのまま速く弾く
  // 隣り合う 2 音が半音（E–F など）なら前の音を止めて、うならせない
  const head = [...new Set(SCORE.THEME.map((n) => n.m))].slice(0, 4);
  head.forEach((m, i) => {
    const semitoneNext = i + 1 < head.length && Math.abs(head[i + 1] - m) === 1;
    pluck(c, o, now(0.25 + i * 0.075), m, { vel: 0.55 + i * 0.08, dur: semitoneNext ? 0.1 : 1.2, kind: 'lyre', pan: -0.2 + i * 0.13 });
  });
}

// ---------------------------------------------------------------------------
// 行動（applyAction の events に合わせて fx.js から呼ぶ）
// ---------------------------------------------------------------------------

/** 移動: 経路の 1 マスごとに石の駒が軽く当たる音 */
export function move(steps, stepSec, side) {
  if (!E.sfxEnabled() || !allow('move', 30)) return;
  const k = sideK(side);
  const o = bus(0.75, 0.1);
  hiss(o, now(), 'bandpass', 900 * k, 0.7, 0.025, 0.05, Math.max(0.1, steps * stepSec));
  for (let i = 0; i < steps; i++) {
    const t = now((i + 0.6) * stepSec);
    tone(o, t, 'sine', vary(270 * k, 0.06), vary(200 * k, 0.06), vary(0.2, 0.1), 0.002, 0.05);
    hiss(o, t, 'lowpass', vary(1300, 0.1), 0.7, 0.06, 0.001, 0.025);
  }
}

/** 近接: 青銅の剣を振る（踏み込みの始まりに） */
export function swing(side) {
  if (!E.sfxEnabled()) return;
  const o = bus(0.8, 0.1);
  hiss(o, now(), 'bandpass', 800 * sideK(side), 1.6, 0.2, 0.07, 0.08, 3200 * sideK(side));
}

/** 弓: 弦の「ビン」と矢の風切り音（flightSec 秒） */
export function bow(side, flightSec) {
  if (!E.sfxEnabled()) return;
  const c = E.context();
  const o = bus(0.85, 0.1);
  pluck(c, o, now(), side === HUMAN ? 45 : 41, { vel: 0.85, dur: 0.4, kind: 'bow' });
  hiss(o, now(), 'highpass', 3000, 0.7, 0.05, 0.001, 0.03);
  hiss(o, now(0.03), 'bandpass', 1900, 1.1, 0.07, flightSec * 0.6, flightSec * 0.5, 900);
}

/** 魔法: きらめく鈴の音。岩越しのときは弧に合わせて音程が上がってから下がる */
export function magic(side, flightSec, over) {
  if (!E.sfxEnabled()) return;
  const c = E.context();
  const o = bus(0.6, 0.45);
  const base = side === HUMAN ? 1174.66 : 932.33; // D6 / Bb5
  for (const [r, lv] of [
    [1, 0.05],
    [1.5, 0.035],
    [2, 0.02],
  ]) {
    const osc = c.createOscillator();
    osc.type = 'sine';
    const t = now();
    osc.frequency.setValueAtTime(base * r, t);
    if (over) {
      osc.frequency.exponentialRampToValueAtTime(base * r * 1.335, t + flightSec * 0.5);
      osc.frequency.exponentialRampToValueAtTime(base * r * 0.94, t + flightSec);
    } else osc.frequency.exponentialRampToValueAtTime(base * r * 1.12, t + flightSec);
    // きらめき（トレモロ）は包絡とは別の段で掛け、鳴り終わりをきれいに消す
    const trem = c.createOscillator();
    trem.frequency.value = 11;
    const tg = c.createGain();
    tg.gain.value = 0.5;
    const tremGain = c.createGain();
    tremGain.gain.value = 1;
    trem.connect(tg).connect(tremGain.gain);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(lv, t + 0.05);
    g.gain.setValueAtTime(lv, t + flightSec);
    g.gain.exponentialRampToValueAtTime(0.0001, t + flightSec + 0.15);
    osc.connect(g).connect(tremGain).connect(o);
    osc.start(t);
    trem.start(t);
    osc.stop(t + flightSec + 0.2);
    trem.stop(t + flightSec + 0.2);
  }
}

/** 命中: kind = 'melee'（青銅の打撃）| 'arrow'（矢が刺さる）| 'magic'（鈴の衝撃） */
export function hit(kind, attackerSide) {
  if (!E.sfxEnabled() || !allow('hit', 30)) return;
  E.duck(0.7, 300);
  const k = sideK(attackerSide);
  const t = now();
  if (kind === 'melee') {
    const o = bus(0.85, 0.2);
    // 青銅の響きの基音は調の中の音（あなた = A4、CPU = F4）にする
    const f = attackerSide === HUMAN ? 440 : 349.23;
    for (const [r, lv, d] of [
      [1, 0.14, 0.5],
      [2.32, 0.08, 0.35],
      [3.67, 0.05, 0.22],
      [5.1, 0.03, 0.15],
    ])
      tone(o, t, 'sine', f * r, f * r * 0.995, lv, 0.001, d);
    hiss(o, t, 'bandpass', 2600, 1.1, 0.25, 0.001, 0.035);
    tone(o, t, 'sine', 120 * k, 70, 0.35, 0.002, 0.14);
  } else if (kind === 'arrow') {
    const o = bus(0.9, 0.12);
    tone(o, t, 'sine', 200 * k, 140 * k, 0.38, 0.002, 0.09);
    hiss(o, t, 'lowpass', 1100, 0.8, 0.2, 0.001, 0.05);
    hiss(o, t, 'highpass', 4000, 0.7, 0.06, 0.001, 0.02);
  } else {
    const o = bus(0.7, 0.45);
    const f = attackerSide === HUMAN ? 1174.66 : 932.33;
    for (const [r, lv, d] of [
      [1, 0.09, 0.7],
      [1.5, 0.06, 0.55],
      [2.01, 0.04, 0.4],
      [3, 0.02, 0.25],
    ])
      tone(o, t, 'sine', f * r, f * r, lv, 0.002, d);
    hiss(o, t, 'highpass', 5000, 0.7, 0.07, 0.001, 0.12);
    tone(o, t, 'sine', 160, 90, 0.2, 0.003, 0.15);
  }
}

/** 押し出し（石が擦れて 1 マス滑る）。dur = 演出の長さ（秒）。着地の音を動きの終わりに合わせる */
export function push(dur = 0.2) {
  if (!E.sfxEnabled()) return;
  const land = Math.max(0.04, dur * 0.55);
  const o = bus(0.85, 0.12);
  hiss(o, now(), 'lowpass', 420, 0.9, 0.22, 0.03, land, 700);
  tone(o, now(land), 'sine', 95, 70, 0.28, 0.003, 0.1);
}

/** 押し出せない（壁に当たる鈍い音） */
export function blocked() {
  if (!E.sfxEnabled()) return;
  const o = bus(0.85, 0.12);
  const t = now(0.04);
  tone(o, t, 'sine', 88, 70, 0.4, 0.003, 0.16);
  tone(o, t, 'triangle', 210, 200, 0.06, 0.002, 0.12);
  hiss(o, t, 'lowpass', 320, 0.7, 0.15, 0.002, 0.06);
}

/** 撃破（駒が砕ける音＋低い余韻） */
export function kill(side) {
  if (!E.sfxEnabled()) return;
  E.duck(0.55, 600);
  const k = side === HUMAN ? 1 : 0.85; // 倒された側
  const o = bus(0.9, 0.3);
  const r = seeded(Math.floor(E.context().currentTime * 997));
  for (let i = 0; i < 14; i++) hiss(o, now(r() * 0.26), 'bandpass', 1400 + r() * 2200, 2, 0.06 + r() * 0.08, 0.001, 0.02 + r() * 0.03);
  tone(o, now(), 'sine', 72 * k, 40, 0.42, 0.004, 0.65);
  tone(o, now(0.03), 'triangle', 620 * k, 190 * k, 0.07, 0.01, 0.38);
}

// ---------------------------------------------------------------------------
// ジングル（主題の引用）
// ---------------------------------------------------------------------------

let activeStinger = null; // 鳴っているジングル（新しいジングル・新しいゲームで止める）

/** 鳴っているジングルを止める（下げていた BGM も戻す） */
export function stopStinger(fade = 0.25) {
  if (!activeStinger) return;
  activeStinger.stop(fade);
  activeStinger = null;
  E.unduck();
}

/**
 * 被害連動ダイスの強化。あなた側 = 失った悲しみから次の反撃への期待（上昇する主題）、CPU 側 = 暗い変形。
 * BGM の上に重ねる（BGM の拍に合わせて入り、その間 BGM は少し下げる）。
 * ジングルは効果音か BGM のどちらかがオンなら鳴らす（効果音オフ・BGM オンのときは BGM の音量で鳴る）。
 */
export function stageUp(side) {
  stopStinger(0.15);
  if (!E.stingerEnabled()) return;
  const st = SCORE.buildStinger(side === HUMAN ? 'stageUp' : 'stageUpCpu');
  const len = (st.beats * 60) / st.bpm;
  const at = Music.nextBeat(now(0.3));
  E.duck(0.5, (at - E.context().currentTime + len) * 1000 + 300);
  // あなた側（反撃への期待）をはっきり、CPU 側は控えめに
  activeStinger = playStinger(E.context(), E.stingerOut(), st, { at, gain: side === HUMAN ? 1.6 : 0.8 });
}

/** 勝敗: BGM を止めてから結果のジングル（'victory' | 'defeat' | 'draw'） */
export function result(kind) {
  Music.stop(0.6);
  stopStinger(0.3);
  if (!E.stingerEnabled()) return;
  activeStinger = playStinger(E.context(), E.stingerOut(), SCORE.buildStinger(kind), { at: now(0.5), gain: 1 });
}

/** ジングルの撥弦の波形を前もって作っておく（unlock の後、手が空いたときに呼ぶ） */
export function warm() {
  if (!E.ready()) return;
  warmStingers(E.context(), ['stageUp', 'stageUpCpu', 'victory', 'defeat', 'draw'].map((k) => SCORE.buildStinger(k)));
}
