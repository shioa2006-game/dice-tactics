// DICE TACTICS — 図案（SVG）
// 駒・紋章・ダイスの目・ロゼットなど、画面で使う図形をここで作る。外部の画像は使わない。
// 着想: ウル王のゲームの象嵌（貝・ラピスラズリ・紅玉髄・瀝青）と、チェスの小さな立体駒。

import { HUMAN, LEADER } from '../core/config.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const n2 = (v) => Math.round(v * 100) / 100;

/** 星形（points 個の頂点）の path */
function starPath(cx, cy, points, rOut, rIn, rot = -90) {
  let d = '';
  for (let i = 0; i < points * 2; i++) {
    const a = ((rot + (i * 180) / points) * Math.PI) / 180;
    const r = i % 2 ? rIn : rOut;
    d += (i ? 'L' : 'M') + n2(cx + r * Math.cos(a)) + ' ' + n2(cy + r * Math.sin(a));
  }
  return d + 'Z';
}

/** 正多角形の頂点列（polygon の points 属性） */
function polyPoints(cx, cy, n, r, rot) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = ((rot + (i * 360) / n) * Math.PI) / 180;
    pts.push(`${n2(cx + r * Math.cos(a))},${n2(cy + r * Math.sin(a))}`);
  }
  return pts.join(' ');
}

/** 円周上に並べた小さな図形 */
function ring(count, r, fn, rot = 0) {
  let out = '';
  for (let i = 0; i < count; i++) {
    const a = ((rot + (i * 360) / count) * Math.PI) / 180;
    out += fn(n2(r * Math.cos(a)), n2(r * Math.sin(a)), (rot + (i * 360) / count));
  }
  return out;
}

// ---------------------------------------------------------------------------
// 紋章（24×24。fill は <use> から継承する）
// ---------------------------------------------------------------------------

const EMBLEMS = {
  // リーダー: 宝珠つきの王冠
  leader: `
    <path d="M4.7 16.8 L3.5 8.4 L8.3 12.1 L12 5.4 L15.7 12.1 L20.5 8.4 L19.3 16.8 Z"/>
    <path d="M4.3 18 H19.7 V20.8 H4.3 Z"/>
    <circle cx="3.5" cy="7" r="1.65"/><circle cx="12" cy="4" r="1.8"/><circle cx="20.5" cy="7" r="1.65"/>`,
  // 戦士: 幅広の剣（太い鍔で弓・杖と見分ける）
  warrior: `
    <path d="M12 1.6 L14.2 4.6 V14.4 H9.8 V4.6 Z"/>
    <path d="M5 14.2 Q12 12.8 19 14.2 V17 Q12 15.6 5 17 Z"/>
    <path d="M10.8 16.6 H13.2 V20.2 H10.8 Z"/>
    <circle cx="12" cy="21.4" r="1.9"/>`,
  // 弓使い: 斜めに構えた弓と矢（弓の曲線が小さくても読めるよう太めに）
  archer: `<g transform="rotate(-45 12 12)">
    <path d="M7.6 1.2 Q25 12 7.6 22.8 L7.6 20.2 Q19.4 12 7.6 3.8 Z"/>
    <path d="M7.9 2.6 L7.9 21.4" fill="none" stroke-width="1.1"/>
    <path d="M1.6 11.2 H18 V12.8 H1.6 Z"/>
    <path d="M23.6 12 L17.4 8.4 V15.6 Z"/>
    <path d="M0.4 8.6 L4.6 12 L0.4 15.4 L2 12 Z"/>
  </g>`,
  // 魔法使い: 八芒星（メソポタミアの星の紋章）
  mage: `<path fill-rule="evenodd" d="${starPath(12, 12, 8, 11, 4.7)} M14.3 12 a2.3 2.3 0 1 0 -4.6 0 a2.3 2.3 0 1 0 4.6 0 Z"/>`,
};
const TYPE_KEYS = ['leader', 'warrior', 'archer', 'mage'];

// ---------------------------------------------------------------------------
// 共通の定義（グラデーション・紋章・ロゼット）を文書に 1 回だけ入れる
// ---------------------------------------------------------------------------

export function installDefs() {
  if (document.getElementById('dt-defs')) return;
  const rosettePetals = ring(8, 0, (x, y, a) => `<ellipse cx="0" cy="-6.2" rx="2.6" ry="5.2" transform="rotate(${a})"/>`);
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.id = 'dt-defs';
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.style.position = 'absolute';
  svg.innerHTML = `
  <defs>
    <radialGradient id="g-h-face" cx="0.36" cy="0.3" r="0.8">
      <stop offset="0" stop-color="#6d97ec"/><stop offset="0.45" stop-color="#2f5cc4"/><stop offset="1" stop-color="#16367f"/>
    </radialGradient>
    <linearGradient id="g-h-rim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#20448f"/><stop offset="1" stop-color="#0a1736"/>
    </linearGradient>
    <radialGradient id="g-m-face" cx="0.36" cy="0.3" r="0.8">
      <stop offset="0" stop-color="#e48a68"/><stop offset="0.45" stop-color="#b34a30"/><stop offset="1" stop-color="#6c2214"/>
    </radialGradient>
    <linearGradient id="g-m-rim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#7a2a19"/><stop offset="1" stop-color="#2a0b05"/>
    </linearGradient>
    <linearGradient id="g-em-h" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fffbef"/><stop offset="0.55" stop-color="#f3dc9e"/><stop offset="1" stop-color="#c99c45"/>
    </linearGradient>
    <linearGradient id="g-em-m" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff7ea"/><stop offset="0.55" stop-color="#efd9b8"/><stop offset="1" stop-color="#bb8f63"/>
    </linearGradient>
    <linearGradient id="g-gold" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fbe7a4"/><stop offset="0.5" stop-color="#d6a845"/><stop offset="1" stop-color="#8a6420"/>
    </linearGradient>
    <radialGradient id="g-shadow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0.55" stop-color="#000" stop-opacity="0.5"/><stop offset="1" stop-color="#000" stop-opacity="0"/>
    </radialGradient>
    ${TYPE_KEYS.map((k) => `<symbol id="em-${k}" viewBox="0 0 24 24" overflow="visible">${EMBLEMS[k]}</symbol>`).join('')}
    <symbol id="rosette" viewBox="-12 -12 24 24">
      <circle r="11.4" fill="#16306b" stroke="#d9b45a" stroke-width="1"/>
      <g fill="#efe4c8">${rosettePetals}</g>
      <circle r="3.4" fill="#a8432c" stroke="#efe4c8" stroke-width="0.8"/>
    </symbol>
  </defs>`;
  document.body.prepend(svg);
}

// ---------------------------------------------------------------------------
// 駒
// ---------------------------------------------------------------------------

// ラピスラズリに混じる黄鉄鉱の粒（人間族の駒の表面）
const FLECKS = [
  [-6.5, -5, 0.55],
  [5.8, -7.2, 0.45],
  [7.4, 4.2, 0.5],
  [-4.2, 7.6, 0.4],
  [1.5, -9.6, 0.35],
  [-9.2, 1.8, 0.4],
];

/**
 * 駒の SVG。人間族 = 円形の台座＋玉縁、モンスター族 = 八角形の台座＋鋸歯縁（色に頼らず形でも区別する）。
 * リーダーは金の二重縁で格上に見せる。
 */
export function pieceSVG(side, type) {
  const h = side === HUMAN;
  const key = TYPE_KEYS[type];
  const leader = type === LEADER;
  const s = h ? 'h' : 'm';
  const face = h
    ? `<circle cy="1.3" r="16.4" fill="url(#g-h-rim)"/>
       <circle cy="1.3" r="16.4" fill="none" stroke="#0a142c" stroke-width="0.8"/>
       <circle cy="-0.7" r="14.6" fill="url(#g-h-face)"/>
       <circle cy="-0.7" r="14.6" fill="none" stroke="${leader ? 'url(#g-gold)' : '#d9b45a'}" stroke-width="${leader ? 1.6 : 0.9}"/>
       <g fill="#f2e6c6" opacity="0.85">${ring(18, 12.6, (x, y) => `<circle cx="${x}" cy="${n2(y - 0.7)}" r="0.62"/>`)}</g>
       <g fill="#f5d77a">${FLECKS.map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" opacity="0.7"/>`).join('')}</g>`
    : `<polygon points="${polyPoints(0, 1.3, 8, 17.2, 22.5)}" fill="url(#g-m-rim)" stroke="#1d0703" stroke-width="0.8" stroke-linejoin="round"/>
       <polygon points="${polyPoints(0, -0.7, 8, 15.4, 22.5)}" fill="url(#g-m-face)" stroke="${leader ? 'url(#g-gold)' : '#d9a066'}" stroke-width="${leader ? 1.6 : 0.9}" stroke-linejoin="round"/>
       <g fill="#f6e3c8" opacity="0.8">${ring(16, 12.4, (x, y, a) => `<path d="M0 -1 L0.9 0.7 L-0.9 0.7 Z" transform="translate(${x} ${n2(y - 0.7)}) rotate(${n2(a + 90)})"/>`)}</g>
       <path d="M-9 -9.5 Q0 -14 9 -9.5" fill="none" stroke="#f3b494" stroke-width="0.8" opacity="0.45"/>`;
  const halo = leader
    ? h
      ? `<circle cy="0.3" r="18.7" fill="none" stroke="url(#g-gold)" stroke-width="1.3"/>`
      : `<polygon points="${polyPoints(0, 0.3, 8, 19.3, 22.5)}" fill="none" stroke="url(#g-gold)" stroke-width="1.3" stroke-linejoin="round"/>`
    : '';
  const sc = leader ? 0.98 : key === 'archer' ? 0.82 : 0.9;
  const em = (dx, dy, fill, extra = '') => `<use href="#em-${key}" x="0" y="0" width="24" height="24" transform="translate(${n2(-12 * sc + dx)} ${n2(-12 * sc - 0.9 + dy)}) scale(${sc})" fill="${fill}" stroke="${fill}" ${extra}/>`;
  return `<svg class="pc-svg" viewBox="-21 -21 42 42" aria-hidden="true">
    <ellipse class="pc-shadow" cx="1.4" cy="3.2" rx="19" ry="18" fill="url(#g-shadow)"/>
    <g class="pc-body">
      ${halo}${face}
      ${em(0.8, 1.1, h ? '#06102a' : '#2a0904', 'opacity="0.6"')}
      ${em(-0.5, -0.55, '#ffffff', 'opacity="0.55"')}
      ${em(0, 0, `url(#g-em-${s})`)}
    </g>
  </svg>`;
}

/** 小さな紋章アイコン（状態表示・ルール表で使う。色は currentColor） */
export function emblemIcon(type, cls = 'ico') {
  return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><use href="#em-${TYPE_KEYS[type]}" fill="currentColor" stroke="currentColor"/></svg>`;
}

/** ロゼット（盤の外枠の装飾。ゲーム上の効果はない） */
export function rosetteSVG(cls = 'rosette') {
  return `<svg class="${cls}" viewBox="-12 -12 24 24" aria-hidden="true"><use href="#rosette" x="-12" y="-12" width="24" height="24"/></svg>`;
}

// ---------------------------------------------------------------------------
// ダイス
// ---------------------------------------------------------------------------

const PIPS = {
  1: [[15, 15]],
  2: [
    [9.5, 20.5],
    [20.5, 9.5],
  ],
  3: [
    [8.5, 21.5],
    [15, 15],
    [21.5, 8.5],
  ],
};

/** ダイスの面（0〜3 の目。0 は中央の小さな輪、未確定は ?） */
export function dieFace(v) {
  if (v === null || v === undefined) return `<svg class="die-svg" viewBox="0 0 30 30" aria-hidden="true"><text x="15" y="20.5" text-anchor="middle" class="die-q">?</text></svg>`;
  const body = v === 0 ? `<circle cx="15" cy="15" r="3.6" class="pip0"/>` : PIPS[v].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="3.3" class="pip"/>`).join('');
  return `<svg class="die-svg" viewBox="0 0 30 30" aria-hidden="true">${body}</svg>`;
}
