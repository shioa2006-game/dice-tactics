// DICE TACTICS — BGM の再生
// メインの 1 曲を初めて必要になったときに書き出し（数秒かかる）、その後はループ再生するだけ。
// 手番では切り替えない。勝敗が決まったら止めて、結果のジングルを鳴らす。消音中は鳴らさない（書き出しもしない）。

import * as E from './engine.js';
import * as SCORE from './score.js';
import { renderSong, bgmSupported } from './render.js';

let song = null; // {buffer, seconds, peak}
let rendering = null;
let failed = false; // 書き出しに失敗した（やり直さない）
let src = null;
let srcGain = null;
let startAt = 0; // 曲の頭を鳴らし始めた時刻（ジングルを拍に合わせるため）
let want = false; // 再生したい状態か（書き出し中に止められたら始めない）
let failHandler = null;

/** 書き出しに失敗したときに呼ぶ処理を登録する（設定画面の更新など） */
export function onFail(fn) {
  failHandler = fn;
}

/** BGM を使える環境か */
export const supported = () => bgmSupported() && !failed;
/** 書き出し済みの曲（確認・計測用） */
export const songInfo = () => song;
const allowed = () => E.ready() && E.settings.bgm && !E.settings.mute && supported();

/** 曲を書き出す（一度だけ） */
export function prepare() {
  if (song) return Promise.resolve(song);
  if (failed) return Promise.resolve(null);
  if (!rendering) {
    // 区間に分けて同時に書き出す（コア数に合わせて最大 6 区間。多すぎると一時的なメモリが増える）
    const chunks = Math.max(2, Math.min(6, navigator.hardwareConcurrency || 4));
    rendering = renderSong(SCORE, { sampleRate: 32000, chunks })
      .then((s) => (song = s))
      .catch((err) => {
        console.error('BGM を書き出せませんでした:', err);
        failed = true;
        if (failHandler) failHandler();
        return null;
      });
  }
  return rendering;
}

/** BGM を始める（設定でオフ・消音中・音がまだ使えないときは何もしない） */
export async function start({ fadeIn = 2.5 } = {}) {
  want = true;
  if (!allowed() || src) return;
  const s = await prepare();
  if (!s || !want || src || !allowed()) return;
  const c = E.context();
  src = c.createBufferSource();
  src.buffer = s.buffer;
  src.loop = true;
  srcGain = c.createGain();
  const now = c.currentTime;
  srcGain.gain.setValueAtTime(0.0001, now);
  srcGain.gain.exponentialRampToValueAtTime(1, now + fadeIn);
  src.connect(srcGain).connect(E.musicOut());
  startAt = now + 0.05;
  src.start(startAt);
}

/** BGM を止める（フェードアウト） */
export function stop(fade = 0.8) {
  want = false;
  if (!src) return;
  const c = E.context();
  const now = c.currentTime;
  const g = srcGain.gain;
  g.cancelScheduledValues(now);
  g.setValueAtTime(Math.max(0.0001, g.value), now);
  g.exponentialRampToValueAtTime(0.0001, now + fade);
  src.stop(now + fade + 0.05);
  src = null;
  srcGain = null;
}

/** 新しいゲーム: 曲の頭からかけ直す */
export function restart() {
  stop(0.4);
  if (allowed()) setTimeout(() => start({ fadeIn: 2 }), 450);
}

export const playing = () => !!src;

/** 時刻 t 以降で、BGM の次の拍の時刻（BGM が鳴っていなければ t のまま） */
export function nextBeat(t) {
  if (!src) return t;
  const spb = 60 / SCORE.SONG_META.bpm;
  return startAt + Math.ceil((t - startAt) / spb - 1e-6) * spb;
}
