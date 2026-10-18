// DICE TACTICS — 楽譜を音にする
// BGM は OfflineAudioContext で 1 ループ分を一度だけ書き出し、ループの終わりから鳴り続ける余韻（弦の減衰・残響）を
// 先頭に重ねて、継ぎ目のないループ用のバッファにする。再生中は AudioBufferSourceNode の loop で鳴らすだけなので軽い。
// ジングル（ダイス強化・勝敗）は短いので、その場で鳴らす。

import { musicMix, playNote, drum, seeded, warmPluck, releaseBuffers } from './instruments.js';
import { makeImpulse, releaseImpulses, context } from './engine.js';

const TAIL_SEC = 5; // ループの終わりから先頭へ回り込ませる余韻の長さ
// 笛の前の音の終わりから、この秒数以内に次の音が始まればつなげて吹く
// （楽譜は音を書いた長さより少し短く切るので、長い音ほど隙間が開く。その分を長さに比例して見込む）
const legatoGap = (prevSec) => 0.06 + 0.06 * prevSec;

/** BGM を書き出せる環境か（OfflineAudioContext と AudioBuffer のコンストラクターが要る） */
export const bgmSupported = () => typeof window.OfflineAudioContext === 'function' && typeof window.AudioBuffer === 'function';

/** 演奏のゆらぎ（決まった種の乱数で、毎回同じ）。撥弦はわずかに前後させ、強さも少し揺らす */
function humanize(notes, hits, spb) {
  const r = seeded(20261018);
  const ns = notes.map((n) => {
    const pluck = n.i === 'lyre' || n.i === 'bass';
    const onBeat = Math.abs(n.t - Math.round(n.t)) < 1e-6;
    const dt = pluck ? (r() - 0.5) * (onBeat ? 0.008 : 0.016) : 0;
    return { ...n, ts: Math.max(0, n.t * spb + dt), v: Math.min(1, n.v * (1 + (r() - 0.5) * 0.08)) };
  });
  const hs = hits.map((h) => ({ ...h, ts: Math.max(0, h.t * spb + (r() - 0.5) * 0.006), v: Math.min(1, h.v * (1 + (r() - 0.5) * 0.1)) }));
  markLegato(ns, spb);
  return { ns, hs };
}

/**
 * 笛の音が前の音に続いているなら、吹き直さずにつなぐ印を付ける。
 * 前の音は次の音の頭まで伸ばし（tieNext）、終わりを短く消して、次の音の立ち上がりと短く重ねる。
 */
function markLegato(ns, spb) {
  const flutes = ns.filter((n) => n.i === 'flute').sort((a, b) => a.ts - b.ts);
  for (let k = 1; k < flutes.length; k++) {
    const prev = flutes[k - 1];
    const next = flutes[k];
    const prevSec = prev.d * spb;
    if (next.ts > prev.ts && next.ts - (prev.ts + prevSec) <= legatoGap(prevSec)) {
      next.legato = true;
      prev.tieNext = true;
      prev.d = (next.ts - prev.ts) / spb + 0.04;
    }
  }
}

/** 打楽器の定位（中央の dum は真ん中、縁の音は少し左右に散らす） */
const DRUM_PAN = { dum: 0, ka: -0.12, tek: 0.15, jingle: 0.3 };

const yieldToUI = () => new Promise((r) => setTimeout(r, 0));

/**
 * BGM を書き出す。
 * @param {object} score score.js のモジュール
 * @returns {Promise<{buffer: AudioBuffer, seconds: number, peak: number}>}
 */
export async function renderSong(score, { sampleRate = 32000, chunks = 4 } = {}) {
  if (!bgmSupported()) throw new Error('この環境では BGM を書き出せません');
  const meta = score.SONG_META;
  const { notes, hits } = score.buildSong();
  const spb = 60 / meta.bpm;
  const loopSec = meta.bars * meta.beatsPerBar * spb;
  const L = Math.round(loopSec * sampleRate);
  const { ns, hs } = humanize(notes, hits, spb);
  const tail = Math.round(TAIL_SEC * sampleRate);

  // 曲を時間で chunks 個に分け、それぞれ別の OfflineAudioContext で同時に書き出す。
  // 書き出しの経路はすべて線形（圧縮などを含まない）なので、区間ごとの結果を足し合わせれば一度に書き出したのと同じになる。
  // 区間を組み立てるたびに処理を譲り、入力（タップ）を止めない。先に始めた区間は、その間も裏で書き出される。
  const seg = Math.ceil(L / chunks);
  const parts = [];
  for (let k = 0; k < chunks; k++) {
    await yieldToUI();
    const s0 = k * seg;
    const s1 = Math.min(L, s0 + seg);
    if (s0 >= s1) break;
    const t0 = s0 / sampleRate;
    const t1 = s1 / sampleRate;
    const inSeg = (ts) => ts >= t0 && ts < t1;
    // 区間の終わりを越えて鳴り続ける音（長い持続音・余韻）が切れないよう、書き出す長さを延ばす
    let end = t1;
    for (const n of ns) if (inSeg(n.ts)) end = Math.max(end, n.ts + n.d * spb);
    const len = Math.round((end - t0) * sampleRate) + tail;
    const off = new OfflineAudioContext(2, len, sampleRate);
    const out = off.createGain();
    out.connect(off.destination);
    const mix = musicMix(off, out, makeImpulse(off, 2.8, 2.4, 11));
    for (const n of ns) if (inSeg(n.ts)) playNote(off, mix, n, n.ts - t0, n.d * spb);
    for (const h of hs) if (inSeg(h.ts)) drum(off, mix.drums, h.ts - t0, h.k, h.v, DRUM_PAN[h.k] || 0, h.ts);
    parts.push(off.startRendering().then((buf) => ({ buf, s0 })));
  }
  let rendered;
  try {
    rendered = await Promise.all(parts);
  } finally {
    // 書き出し用（32kHz）の撥弦・雑音・残響の波形はもう使わないので捨てる（再生中の AudioContext と同じレートなら残す）
    const live = context();
    if (!live || live.sampleRate !== sampleRate) {
      releaseBuffers(sampleRate);
      releaseImpulses(sampleRate);
    }
  }

  // 区間を足し合わせ、ループの終わりからはみ出した余韻は先頭へ回り込ませる（区間は L より短いので回り込みは 1 回）
  const buffer = new AudioBuffer({ length: L, numberOfChannels: 2, sampleRate });
  for (const { buf, s0 } of rendered) {
    await yieldToUI();
    for (let ch = 0; ch < 2; ch++) {
      const src = buf.getChannelData(ch);
      const dst = buffer.getChannelData(ch);
      const n1 = Math.min(src.length, L - s0);
      for (let i = 0; i < n1; i++) dst[s0 + i] += src[i];
      for (let i = n1; i < src.length; i++) dst[s0 + i - L] += src[i];
    }
  }
  await yieldToUI();
  let peak = 0;
  for (let ch = 0; ch < 2; ch++) {
    const d = buffer.getChannelData(ch);
    for (let i = 0; i < L; i++) {
      const v = d[i] < 0 ? -d[i] : d[i];
      if (v > peak) peak = v;
    }
  }
  // 最大値を -1.5dBFS にそろえる（音量は BGM の音量設定で決める）
  const gain = peak > 0 ? 0.84 / peak : 1;
  for (let ch = 0; ch < 2; ch++) {
    await yieldToUI();
    const d = buffer.getChannelData(ch);
    for (let i = 0; i < L; i++) d[i] *= gain;
  }
  return { buffer, seconds: loopSec, peak };
}

/**
 * ジングルをその場で鳴らす（score.buildStinger(kind) の音符）。
 * @returns {{len: number, stop: (fade?: number) => void}} 鳴り終わるまでの秒数と、途中で止める関数
 */
export function playStinger(c, out, stinger, { at = c.currentTime + 0.04, gain = 1 } = {}) {
  const g = c.createGain();
  g.gain.value = gain;
  g.connect(out);
  const mix = musicMix(c, g, makeImpulse(c, 2.4, 2.4, 5));
  const spb = 60 / stinger.bpm;
  for (const n of stinger.notes) playNote(c, mix, n, at + n.t * spb, n.d * spb);
  for (const h of stinger.hits || []) drum(c, mix.drums, at + h.t * spb, h.k, h.v, DRUM_PAN[h.k] || 0);
  const len = stinger.beats * spb;
  const timer = setTimeout(() => g.disconnect(), (at - c.currentTime + len + 4) * 1000);
  return {
    len,
    stop(fade = 0.25) {
      const t = c.currentTime;
      g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(g.gain.value, t);
      g.gain.setTargetAtTime(0, t, fade / 4);
      clearTimeout(timer);
      setTimeout(() => g.disconnect(), fade * 1000 + 150);
    },
  };
}

/** ジングルの撥弦の波形を前もって作る（最初のジングルでメインスレッドが止まらないように） */
export function warmStingers(c, stingers) {
  for (const st of stingers) for (const n of st.notes) if (n.i === 'lyre' || n.i === 'bass') warmPluck(c, n.m, n.i, n.v);
}
