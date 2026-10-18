// DICE TACTICS — 演出
// コアの applyAction() が返す events を順に見せるだけ。状態はここで計算し直さない。
// 時間待ちには必ず setTimeout の上限を付け、背景タブや描画停止でも進行が止まらないようにする。

import { ARCHER, MAGE, DIRS } from '../core/config.js';
import * as V from './view.js';

const REASON = { edge: '盤の端', obstacle: '岩', unit: '駒' };
const reducedMQ = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };

let cfg = null;
let factor = 1; // 再生速度（大きいほどゆっくり）
let calm = false;
const running = new Set();

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function init(config) {
  cfg = config;
}
export function setCalm(v) {
  calm = !!v;
}
/** 動きを省略するか（演出を控えめに・OS の設定・背景タブ） */
export const still = () => calm || reducedMQ.matches || document.hidden;

function play(el, keyframes, ms, easing = 'ease-in-out') {
  if (still() || !el.animate) return Promise.resolve();
  const duration = Math.max(1, ms * factor);
  const a = el.animate(keyframes, { duration, easing });
  running.add(a);
  return Promise.race([a.finished.catch(() => {}), sleep(duration + 150)]).then(() => running.delete(a));
}
const wait = (ms) => (still() ? Promise.resolve() : sleep(ms * factor));

function fxEl(cls, transform, html = '') {
  const el = document.createElement('div');
  el.className = 'fx-el ' + cls;
  el.innerHTML = html;
  el.style.transform = transform;
  V.fxLayer().appendChild(el);
  return el;
}
function fadeOut(el, delay, ms = 300) {
  setTimeout(() => {
    if (!el.isConnected) return;
    play(el, [{ opacity: 1 }, { opacity: 0 }], ms, 'ease-out').then(() => el.remove());
  }, delay * factor);
}

/** 新しいゲームなどで、再生中の演出をすべて打ち切る */
export function cancelAll() {
  for (const a of running) a.cancel();
  running.clear();
  const layer = V.fxLayer();
  if (layer) layer.innerHTML = '';
}

// ---------------------------------------------------------------------------
// 行動の再生
// ---------------------------------------------------------------------------

/** events（applyAction の戻り値）を順に再生する */
export async function playEvents(events, { speed = 1 } = {}) {
  factor = speed;
  let attack = null;
  const tails = []; // 最後まで待つ演出（近接攻撃の戻りなど）
  for (const e of events) {
    if (e.type === 'move') await move(e);
    else if (e.type === 'attack') {
      attack = e;
      const t = await strike(e);
      if (t) tails.push(t);
    } else if (e.type === 'damage') await damage(e, attack);
    else if (e.type === 'kill') await kill(e);
    else if (e.type === 'knockback') await knockback(e);
    else if (e.type === 'knockbackBlocked') await blocked(e, attack);
  }
  await Promise.all(tails);
}

async function move(e) {
  const el = V.pieceEl(e.unit);
  el.style.transform = V.cellTransform(e.to);
  if (still()) return;
  for (const c of e.path.slice(0, -1)) fadeOut(fxEl('fx-dot', V.cellTransform(c)), 260, 420);
  el.classList.add('lifted');
  await play(
    el,
    [e.from, ...e.path].map((c) => ({ transform: V.cellTransform(c) })),
    Math.min(600, 140 + 90 * e.path.length),
  );
  el.classList.remove('lifted');
}

/** 攻撃の軌跡。命中の瞬間に戻る（近接の引き戻しは tail として返す） */
async function strike(e) {
  const type = cfg.unitType[e.unit];
  const [fx, fy] = V.xy(e.from);
  const [tx, ty] = V.xy(e.to);
  if (type === ARCHER) {
    const p = fxEl('fx-proj', V.at(fx, fy), arrowSVG(e.dir));
    await play(p, [{ transform: V.at(fx, fy) }, { transform: V.at(tx, ty) }], 130 + 45 * e.dist, 'cubic-bezier(.4,0,.9,.6)');
    p.remove();
    return null;
  }
  if (type === MAGE) {
    const o = fxEl('fx-orb', V.at(fx, fy));
    const frames = [{ transform: V.at(fx, fy) + ' scale(.6)' }];
    if (e.overObstacle) {
      // 岩越し: 弧を描いて飛ぶ
      const [px, py] = fy === ty ? [0, -0.9] : [0.9, 0];
      frames.push({ transform: V.at((fx + tx) / 2 + px, (fy + ty) / 2 + py) + ' scale(1.25)', offset: 0.5 });
    }
    frames.push({ transform: V.at(tx, ty) + ' scale(1)' });
    await play(o, frames, 240 + 50 * e.dist, 'ease-in-out');
    o.remove();
    return null;
  }
  // 剣・王: 対象へ踏み込んで戻る
  const el = V.pieceEl(e.unit);
  el.classList.add('lifted');
  const lunge = play(
    el,
    [
      { transform: V.at(fx, fy) },
      { transform: V.at(fx + (tx - fx) * 0.42, fy + (ty - fy) * 0.42), offset: 0.45 },
      { transform: V.at(fx, fy) },
    ],
    300,
    'ease-in-out',
  ).then(() => el.classList.remove('lifted'));
  await wait(135);
  return lunge;
}

function arrowSVG(dir) {
  return `<svg viewBox="-10 -10 20 20"><g transform="rotate(${dir * 90})"><path d="M0 -9.5 L3 -4 H1 V7.5 H-1 V-4 H-3 Z" fill="#3b2a12" stroke="#fff3d0" stroke-width="0.9" stroke-linejoin="round"/><path d="M0 5 L-2.6 9 M0 5 L2.6 9" stroke="#fff3d0" stroke-width="1"/></g></svg>`;
}

async function damage(e, attack) {
  const c = attack ? attack.to : -1;
  if (c < 0) return;
  const [x, y] = V.xy(c);
  V.setHp(e.unit, e.hp, true);
  const b = fxEl('fx-burst' + (e.hp <= 0 ? ' kill' : ''), V.at(x, y));
  play(b, [{ transform: V.at(x, y) + ' scale(.3)', opacity: 1 }, { transform: V.at(x, y) + ' scale(1.35)', opacity: 0 }], 360, 'ease-out').then(() => b.remove());
  floatText(x, y, e.hp > 0 ? '−1' : '', '');
  if (e.hp <= 0) return;
  const [dx, dy] = DIRS[attack.dir];
  await play(
    V.pieceEl(e.unit),
    [
      { transform: V.at(x, y) },
      { transform: V.at(x + dx * 0.14, y + dy * 0.14), offset: 0.3 },
      { transform: V.at(x - dx * 0.05, y - dy * 0.05), offset: 0.65 },
      { transform: V.at(x, y) },
    ],
    220,
    'ease-out',
  );
}

function floatText(x, y, text, cls) {
  if (!text) return;
  const f = fxEl('fx-float ' + cls, V.at(x, y - 0.35), text);
  play(f, [{ transform: V.at(x, y - 0.3), opacity: 1 }, { transform: V.at(x, y - 0.75), opacity: 1, offset: 0.7 }, { transform: V.at(x, y - 0.9), opacity: 0 }], 750, 'ease-out').then(() => f.remove());
  if (still()) setTimeout(() => f.remove(), 700);
}

async function kill(e) {
  const el = V.pieceEl(e.unit);
  const [x, y] = V.xy(e.at);
  floatText(x, y, '撃破', 'kill');
  el.style.opacity = '0';
  await play(
    el,
    [
      { transform: V.at(x, y), opacity: 1, filter: 'brightness(1)' },
      { transform: V.at(x, y) + ' scale(1.18)', opacity: 1, filter: 'brightness(1.8)', offset: 0.3 },
      { transform: V.at(x, y) + ' scale(.25) rotate(25deg)', opacity: 0, filter: 'brightness(1)' },
    ],
    460,
    'ease-in',
  );
  el.hidden = true;
}

async function knockback(e) {
  const el = V.pieceEl(e.unit);
  el.style.transform = V.cellTransform(e.to);
  await play(el, [{ transform: V.cellTransform(e.from) }, { transform: V.cellTransform(e.to) }], 220, 'cubic-bezier(.2,.9,.3,1)');
}

async function blocked(e, attack) {
  const [x, y] = V.xy(e.at);
  const [dx, dy] = DIRS[attack.dir];
  const mark = fxEl('fx-x', V.at(x + dx * 0.55, y + dy * 0.55), `<div>✕<small>${REASON[e.reason]}</small></div>`);
  fadeOut(mark, 700, 350);
  if (still()) setTimeout(() => mark.remove(), 900);
  await play(
    V.pieceEl(e.unit),
    [{ transform: V.at(x, y) }, { transform: V.at(x + dx * 0.2, y + dy * 0.2), offset: 0.4 }, { transform: V.at(x, y) }],
    240,
    'ease-out',
  );
}

/** 「移動を戻す」: 駒を元のマスへ滑らせる */
export async function slide(u, from, to, speed = 1) {
  factor = speed;
  const el = V.pieceEl(u);
  el.style.transform = V.cellTransform(to);
  await play(el, [{ transform: V.cellTransform(from) }, { transform: V.cellTransform(to) }], 200, 'ease-out');
}

// ---------------------------------------------------------------------------
// ダイス
// ---------------------------------------------------------------------------

/** ダイスを転がす（出目はすでに決まっている。表示だけを揺らしてから止める） */
export async function rollDice(values, maxes, speed = 1) {
  if (still()) return;
  const dur = 560 * speed;
  const t0 = performance.now();
  while (performance.now() - t0 < dur) {
    V.showDice(
      maxes.map((m) => Math.floor(Math.random() * (m + 1))),
      maxes,
      'rolling',
    );
    await sleep(70);
  }
  V.showDice(values, maxes, 'landed');
  await sleep(160 * speed);
}
