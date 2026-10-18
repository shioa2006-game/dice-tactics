// DICE TACTICS — 描画
// app.js が持つゲームの状態（game）を受け取り、DOM を書き換えるだけ。ゲームの進行やルール判定はしない。
// 行動の候補・押し出し先などは、すべてコアの関数（rules.js）が返した値を表示する。

import { HUMAN, MONSTER, LEADER, MAGE, ATTACKED, MOVED, DIRS, UNIT_TYPES, unitName } from '../core/config.js';
import { BASE_AP, DICE_STAGES, maxAP } from '../core/dice.js';
import * as R from '../core/rules.js';
import * as A from './art.js';

const $ = (sel) => document.querySelector(sel);
const WHO = ['あなた', 'CPU'];
const RANGE_TEXT = ['隣接', '隣接', '2〜4', '1〜2（岩越し可）'];

let cfg = null;
const cellEls = [];
const pieceEls = [];

// ---------------------------------------------------------------------------
// 位置（駒・演出の要素は 1 マス分の大きさで、translate でマスに置く）
// ---------------------------------------------------------------------------

/** マスの座標（小数可）→ transform */
export function at(x, y) {
  return `translate(${Math.round(x * 1000) / 10}%, ${Math.round(y * 1000) / 10}%)`;
}
export function xy(c) {
  return [c % cfg.W, (c / cfg.W) | 0];
}
export function cellTransform(c) {
  const [x, y] = xy(c);
  return at(x, y);
}
export const pieceEl = (u) => pieceEls[u];
export const fxLayer = () => $('#fx');

// ---------------------------------------------------------------------------
// 初期化
// ---------------------------------------------------------------------------

/** 盤面・駒・座標・装飾を作る。タップされたマス番号を onCell に渡す */
export function init(config, onCell) {
  cfg = config;
  A.installDefs();

  const cells = $('#cells');
  cells.innerHTML = '';
  cellEls.length = 0;
  for (let c = 0; c < cfg.CELLS; c++) {
    const el = document.createElement('div');
    const [x, y] = xy(c);
    el.className = 'cell' + ((x + y) % 2 ? ' alt' : '') + (cfg.obstacle[c] ? ' rock' : '');
    el.dataset.cell = c;
    el.setAttribute('role', 'gridcell');
    cells.appendChild(el);
    cellEls.push(el);
  }
  $('#board').addEventListener('click', (e) => {
    const el = e.target.closest('.cell');
    if (el) onCell(+el.dataset.cell);
  });
  // 長押しメニュー・ダブルタップ拡大を盤面で起こさない
  $('#board').addEventListener('contextmenu', (e) => e.preventDefault());

  const pieces = $('#pieces');
  pieces.innerHTML = '';
  pieceEls.length = 0;
  for (let u = 0; u < cfg.unitCount; u++) {
    const side = cfg.unitSide[u];
    const t = cfg.unitType[u];
    const el = document.createElement('div');
    el.className = `piece ${side === HUMAN ? 'h' : 'm'} ${UNIT_TYPES[t].key}${t === LEADER ? ' leader' : ''}`;
    const hp = '<i></i>'.repeat(cfg.types[t].hp);
    el.innerHTML = `<div class="pc-wrap">${A.pieceSVG(side, t)}<span class="mark"></span>${cfg.unitNo[u] ? `<span class="num">${cfg.unitNo[u]}</span>` : ''}<span class="hp">${hp}</span></div>`;
    pieces.appendChild(el);
    pieceEls.push(el);
  }

  $('.coords.cols').innerHTML = Array.from({ length: cfg.W }, (_, i) => `<span>${String.fromCharCode(65 + i)}</span>`).join('');
  $('.coords.rows').innerHTML = Array.from({ length: cfg.H }, (_, i) => `<span>${cfg.H - i}</span>`).join('');
  for (const k of ['tl', 'tr', 'bl', 'br']) $(`.corner.${k}`).innerHTML = A.rosetteSVG();
  $('#result-orn').innerHTML = A.rosetteSVG() + A.rosetteSVG() + A.rosetteSVG();
  renderRules();
}

// ---------------------------------------------------------------------------
// 画面全体
// ---------------------------------------------------------------------------

export function render(game) {
  renderBoard(game);
  renderPieces(game);
  renderStatus(game);
  renderTray(game);
  renderInfo(game);
  renderLog(game);
}

/** 選択中の自軍ユニットの行動候補（自分の行動中のみ） */
function options(game) {
  const s = game.state;
  const moves = new Map();
  const targets = new Map();
  if (game.mode === 'act' && !game.busy && game.sel >= 0 && cfg.unitSide[game.sel] === HUMAN) {
    for (const m of R.moveOptions(s, game.sel)) moves.set(m.cell, m);
    for (const a of R.attackOptions(s, game.sel)) targets.set(a.target, a);
  }
  return { moves, targets };
}

function renderBoard(game) {
  const s = game.state;
  const occ = R.occupancy(s);
  const { moves, targets } = options(game);
  const pv = game.preview;
  const path = new Set(pv && pv.kind === 'move' ? pv.path.slice(0, -1) : []);
  const after = new Set(pv && pv.kind === 'move' ? pv.after : []);
  const threat = game.threatSet || new Set();
  for (let c = 0; c < cfg.CELLS; c++) {
    const el = cellEls[c];
    const u = occ[c];
    const m = moves.get(c);
    const isDest = pv && pv.kind === 'move' && pv.cell === c;
    el.classList.toggle('move', !!m);
    el.classList.toggle('dest', !!isDest);
    el.classList.toggle('path', path.has(c));
    el.classList.toggle('target', u >= 0 && targets.has(u));
    el.classList.toggle('pv', u >= 0 && pv && pv.kind === 'attack' && pv.target === u);
    el.classList.toggle('after', u >= 0 && after.has(u));
    el.classList.toggle('sel', u >= 0 && u === game.sel && cfg.unitSide[u] === HUMAN);
    el.classList.toggle('inspect', u >= 0 && u === game.sel && cfg.unitSide[u] !== HUMAN);
    el.classList.toggle('acting', u >= 0 && u === game.acting);
    el.classList.toggle('threat', u >= 0 && threat.has(u));
    const cost = m ? `<span class="cost">${m.cost}</span>` : '';
    if (el.innerHTML !== cost) el.innerHTML = cost;
    el.setAttribute('aria-label', cellLabel(s, c, u, m, targets.has(u)));
  }
  renderOverlay(game);
}

function cellLabel(s, c, u, m, isTarget) {
  let t = R.cellName(c, cfg);
  if (cfg.obstacle[c]) return t + ' 岩';
  if (u >= 0) t += ` ${cfg.unitSide[u] === HUMAN ? '人間族' : 'モンスター族'}の${unitName(cfg, u)} HP${s.hp[u]}`;
  if (m) t += ` 移動 ${m.cost}AP`;
  if (isTarget) t += ' 攻撃できる';
  return t;
}

/** プレビューの線（移動の経路・攻撃の射線・押し出し先） */
function renderOverlay(game) {
  const s = game.state;
  const pv = game.preview;
  const ov = $('#overlay');
  if (!pv) {
    if (ov.innerHTML) ov.innerHTML = '';
    return;
  }
  const P = (c) => {
    const [x, y] = xy(c);
    return [x * 10 + 5, y * 10 + 5];
  };
  let h = '';
  if (pv.kind === 'move') {
    const pts = [pv.from, ...pv.path].map(P);
    h += `<polyline class="ov-path" points="${pts.map((p) => p.join(',')).join(' ')}"/>`;
    const [dx, dy] = P(pv.cell);
    h += `<circle class="ov-ghost" cx="${dx}" cy="${dy - 0.3}" r="3.9"/>`;
  } else {
    const o = pv.opt;
    const [ax, ay] = P(s.pos[game.sel]);
    const [tx, ty] = P(o.cell);
    const magic = cfg.unitType[game.sel] === MAGE;
    if (o.overObstacle) {
      // 岩越しの魔法は弧で描く
      const mx = (ax + tx) / 2 + (ay === ty ? 0 : 7);
      const my = (ay + ty) / 2 - (ay === ty ? 7 : 0);
      h += `<path class="ov-shot magic" d="M${ax} ${ay} Q${mx} ${my} ${tx} ${ty}"/>`;
    } else h += `<line class="ov-shot${magic ? ' magic' : ''}" x1="${ax}" y1="${ay}" x2="${tx}" y2="${ty}"/>`;
    if (o.hit.knockback) {
      const [ddx, ddy] = DIRS[o.dir];
      if (o.hit.dest >= 0) {
        const [ex, ey] = P(o.hit.dest);
        h += `<line class="ov-push" x1="${tx + ddx * 3}" y1="${ty + ddy * 3}" x2="${ex - ddx * 1.5}" y2="${ey - ddy * 1.5}"/>`;
        h += `<polygon class="ov-push-head" points="${arrowHead(ex + ddx * 1.2, ey + ddy * 1.2, ddx, ddy)}"/>`;
        h += `<rect x="${ex - 4.4}" y="${ey - 4.4}" width="8.8" height="8.8" rx="0.6" fill="none" stroke="#e2461f" stroke-width="0.6" stroke-dasharray="1.2 0.9"/>`;
      } else {
        // 押し出せない: 押し出す方向の境目に ✕
        const bx = tx + ddx * 5;
        const by = ty + ddy * 5;
        h += `<circle class="ov-block-bg" cx="${bx}" cy="${by}" r="2.4"/>`;
        h += `<path class="ov-block" d="M${bx - 1.1} ${by - 1.1} L${bx + 1.1} ${by + 1.1} M${bx + 1.1} ${by - 1.1} L${bx - 1.1} ${by + 1.1}"/>`;
      }
    }
  }
  ov.innerHTML = h;
}

function arrowHead(x, y, dx, dy) {
  // (dx, dy) 方向を向いた三角形
  const px = -dy;
  const py = dx;
  const pts = [
    [x + dx * 1.8, y + dy * 1.8],
    [x - dx * 0.6 + px * 1.6, y - dy * 0.6 + py * 1.6],
    [x - dx * 0.6 - px * 1.6, y - dy * 0.6 - py * 1.6],
  ];
  return pts.map((p) => p.map((v) => Math.round(v * 100) / 100).join(',')).join(' ');
}

// ---------------------------------------------------------------------------
// 駒
// ---------------------------------------------------------------------------

function renderPieces(game) {
  const s = game.state;
  const myTurn = game.mode === 'act';
  for (let u = 0; u < cfg.unitCount; u++) {
    const el = pieceEls[u];
    const alive = s.pos[u] >= 0;
    el.hidden = !alive;
    if (!alive) continue;
    el.style.transform = cellTransform(s.pos[u]);
    el.style.opacity = '';
    setHp(u, s.hp[u]);
    const side = cfg.unitSide[u];
    const own = side === s.side && s.phase === 'act';
    const T = cfg.types[cfg.unitType[u]];
    const attacked = own && (s.flags[u] & ATTACKED) !== 0;
    const moved = own && (s.flags[u] & MOVED) !== 0;
    // 移動済みで攻撃の AP も残っていなければ、このターンはもう動けない
    const done = attacked || (moved && s.ap < T.attackCost);
    const ready = myTurn && side === HUMAN && !done && R.attackOptions(s, u).length > 0;
    el.classList.toggle('done', done);
    el.classList.toggle('moved', moved && !done);
    el.classList.toggle('ready', ready);
  }
}

/** HP の目盛りを更新（pop = 減った目盛りを光らせる） */
export function setHp(u, hp, pop = false) {
  const chips = pieceEls[u].querySelectorAll('.hp i');
  chips.forEach((ch, i) => {
    const lost = i >= hp;
    if (pop && lost && !ch.classList.contains('lost')) {
      ch.classList.remove('pop');
      void ch.offsetWidth;
      ch.classList.add('pop');
    }
    ch.classList.toggle('lost', lost);
  });
}

// ---------------------------------------------------------------------------
// ステータス帯（両陣営の残り・ダイス強化段階）
// ---------------------------------------------------------------------------

function renderStatus(game) {
  const s = game.state;
  for (const side of [MONSTER, HUMAN]) {
    const el = $(side === HUMAN ? '#stat-h' : '#stat-m');
    const st = R.diceStageOf(s, side);
    const roster = cfg.sideUnits[side]
      .map((u) => `<span class="unit-ico${s.pos[u] < 0 ? ' dead' : ''}" title="${unitName(cfg, u)}">${A.emblemIcon(cfg.unitType[u])}</span>`)
      .join('');
    const html = `<div class="ss-head"><span class="ss-name">${side === HUMAN ? 'あなた' : 'CPU'}</span><span class="stage-badge${st > 0 ? ' up' : ''}" data-side="${side}" title="ダイス強化段階（失った味方 ${s.lost[side]} 体）">▲${st}</span><span class="ss-max">最大<b>${maxAP(s.lost[side])}</b>AP</span></div><div class="ss-roster">${roster}</div>`;
    if (el.dataset.html !== html) {
      el.innerHTML = html;
      el.dataset.html = html;
    }
    el.classList.toggle('active', s.phase !== 'over' && s.side === side);
    el.setAttribute('aria-label', `${side === HUMAN ? 'あなた（人間族）' : 'CPU（モンスター族）'}: ダイス強化 ▲${st}、最大 ${maxAP(s.lost[side])}AP、残り ${cfg.sideUnits[side].filter((u) => s.pos[u] >= 0).length} 体`);
  }
  $('#round').innerHTML = `ROUND <b>${R.roundOf(s)}</b>/${cfg.rules.maxRounds}`;
  const turn = $('#turn');
  if (s.phase === 'over') {
    turn.textContent = s.winner === 'draw' ? '引き分け' : s.winner === HUMAN ? 'あなたの勝ち' : 'CPU の勝ち';
    turn.className = 'turn';
  } else {
    turn.textContent = s.side === HUMAN ? 'あなたの番' : 'CPU の番';
    turn.className = 'turn ' + (s.side === HUMAN ? 'h' : 'm');
  }
}

/** ステータス帯の強化段階を光らせる */
export function pulseStage(side) {
  const b = document.querySelector(`.stage-badge[data-side="${side}"]`);
  if (!b) return;
  b.classList.remove('pulse');
  void b.offsetWidth;
  b.classList.add('pulse');
}

// ---------------------------------------------------------------------------
// ダイスと AP・ターン操作
// ---------------------------------------------------------------------------

function renderTray(game) {
  const s = game.state;
  const tray = $('#tray');
  const side = s.phase === 'over' ? HUMAN : s.side;
  const rolled = s.phase === 'act' && s.dice;
  tray.classList.toggle('m', side === MONSTER);
  $('#dice-owner').textContent = side === HUMAN ? 'あなたのダイス' : 'CPU のダイス';

  if (!game.diceAnimating) {
    const maxes = rolled ? s.diceMax : R.diceMaxOf(s, side);
    // 強化されたばかりのダイス（通知が出ている陣営の、まだ振っていないダイス）
    const prevMax = game.notice && game.notice.side === side && !rolled ? DICE_STAGES[Math.max(0, R.diceStageOf(s, side) - 1)] : null;
    $('#dice').innerHTML = maxes.map((mx, i) => dieHTML(rolled ? s.dice[i] : null, mx, prevMax && mx > prevMax[i])).join('');
  }

  const top = maxAP(s.lost[side]);
  const apNum = $('#ap-num');
  const chips = $('#ap-chips');
  if (rolled) {
    apNum.textContent = s.ap;
    apNum.className = 'ap-num' + (s.ap === 0 ? ' zero' : s.apGained >= 7 ? ' big' : '');
    $('#ap-of').textContent = `/ ${s.apGained}`;
    $('#ap-formula').innerHTML = `基本${BASE_AP} + ${s.dice.join(' + ')} = <b class="${s.apGained >= 7 ? 'gold' : ''}">${s.apGained}AP</b>`;
  } else {
    apNum.textContent = '–';
    apNum.className = 'ap-num zero';
    $('#ap-of').textContent = `1〜${top}`;
    $('#ap-formula').innerHTML = s.phase === 'over' ? '' : `基本${BASE_AP} + ダイス 3 個（▲${R.diceStageOf(s, side)}：${R.diceMaxOf(s, side).join('・')}）`;
  }
  if (!game.diceAnimating) {
    let ch = '';
    for (let i = 0; i < top; i++) {
      // 振った直後は、獲得した AP の目盛りを順に点灯させる
      const fresh = rolled && game.apFresh && i < s.ap;
      const cls = !rolled ? '' : i < s.ap ? 'on' + (fresh ? ' light' : '') : i < s.apGained ? 'spent' : '';
      ch += `<i class="${cls}"${fresh ? ` style="animation-delay:${i * 45}ms"` : ''}></i>`;
    }
    syncChips(chips, ch);
  }

  // 主ボタンは局面で切り替える（振る前 = ダイスを振る、振った後 = ターン終了）
  const main = $('#btn-main');
  main.classList.remove('armed', 'urge');
  main.disabled = game.busy;
  if (game.mode === 'roll') {
    main.innerHTML = 'ダイスを振る<span class="kbd">Space</span>';
  } else if (game.mode === 'act') {
    if (game.endArmed) {
      main.classList.add('armed');
      main.innerHTML = `残り ${s.ap}AP — もう一度押して終了`;
    } else {
      main.innerHTML = 'ターン終了<span class="kbd">E</span>';
      if (s.ap === 0 || !game.canAct) main.classList.add('urge');
    }
  } else if (game.mode === 'cpu') {
    main.disabled = true;
    main.textContent = game.cpuThinking ? 'CPU が考えています…' : 'CPU の手番';
  } else if (game.mode === 'over') {
    main.innerHTML = 'もう一度遊ぶ';
  } else {
    main.disabled = true;
    main.textContent = '';
  }
  const undo = $('#btn-undo');
  undo.hidden = game.mode !== 'act';
  undo.disabled = game.busy || game.undo.length === 0;
  undo.innerHTML = '戻す<span class="kbd">Z</span>';
}

function syncChips(el, html) {
  if (el.dataset.html === html) return;
  el.innerHTML = html;
  el.dataset.html = html;
}

function dieHTML(v, mx, isNew) {
  const cls = `die${mx >= 3 ? ' up' : ''}${v !== null && v === mx ? ' max' : ''}${isNew ? ' new' : ''}`;
  const label = v === null ? `ダイス 0〜${mx}` : `出目 ${v}（0〜${mx}）`;
  return `<div class="${cls}" role="img" aria-label="${label}"><div class="die-face">${A.dieFace(v)}</div><div class="die-range">0–${mx}</div></div>`;
}

/** ダイスを転がす演出用: 表示だけを差し替える */
export function showDice(values, maxes, cls = '') {
  $('#dice').innerHTML = maxes.map((mx, i) => dieHTML(values ? values[i] : null, mx, false).replace('class="die', `class="die ${cls}`)).join('');
}

// ---------------------------------------------------------------------------
// 情報行（選択中の駒・行動案・ヒント・エラー）
// ---------------------------------------------------------------------------

function renderInfo(game) {
  const info = $('#info');
  const { main, sub, cls, confirm } = infoContent(game);
  info.className = 'info' + (cls ? ' ' + cls : '');
  $('#info-main').innerHTML = main;
  $('#info-sub').innerHTML = sub || '';
  $('#btn-confirm').hidden = !confirm;
}

function unitLine(s, u) {
  const T = cfg.types[cfg.unitType[u]];
  const side = cfg.unitSide[u];
  let st = '';
  if (side === s.side && s.phase === 'act') st = s.flags[u] & ATTACKED ? '・攻撃済み' : s.flags[u] & MOVED ? '・移動済み' : '・未行動';
  return `<span class="tag ${side === HUMAN ? 'h' : 'm'}">${side === HUMAN ? '味方' : '敵'}</span>${unitName(cfg, u)} HP${s.hp[u]}/${T.hp}・射程 ${RANGE_TEXT[cfg.unitType[u]]}・攻撃${T.attackCost}AP${st}`;
}

function infoContent(game) {
  const s = game.state;
  if (game.msg) {
    const u = game.msg.inspect >= 0 ? game.msg.inspect : game.sel;
    return { main: game.msg.text, sub: u >= 0 && s.pos[u] >= 0 ? unitLine(s, u) : '', cls: game.msg.cls };
  }
  if (game.preview) return { main: game.preview.text, sub: game.preview.sub, cls: 'preview', confirm: !game.busy };
  if (game.busy && game.mode === 'act') return { main: game.actNote || '…', sub: '' };
  if (game.busy && game.mode === 'roll') return { main: 'ダイスを振っています…', sub: '' };
  if (game.mode === 'cpu') return { main: game.cpuNote || 'CPU の手番です。', sub: game.cpuSub || '' };
  if (game.mode === 'over') return { main: s.winner === 'draw' ? '引き分けです。' : s.winner === HUMAN ? 'あなたの勝ちです！' : 'CPU の勝ちです。', sub: '「もう一度遊ぶ」で新しいゲームを始めます。盤面はそのまま確認できます。' };
  if (game.sel >= 0 && s.pos[game.sel] >= 0) {
    const own = cfg.unitSide[game.sel] === HUMAN;
    let sub = '';
    if (game.mode === 'act' && own) {
      const { moves, targets } = options(game);
      if (moves.size && targets.size) sub = '青いマスへ移動、赤い鉤形の敵を攻撃。タップでプレビュー → もう一度で確定。';
      else if (moves.size) sub = '青いマスをタップで移動先をプレビュー（数字は消費 AP）。';
      else if (targets.size) sub = '赤い鉤形の敵をタップで攻撃をプレビュー。';
      else sub = moveBlockReason(s, game.sel);
    } else if (!own) sub = '敵の駒です。';
    return { main: unitLine(s, game.sel), sub };
  }
  return { main: game.hint || '', sub: game.hintSub || '' };
}

/** この駒が今行動できない理由（コアの判定文をそのまま使う） */
function moveBlockReason(s, u) {
  if (s.flags[u] & ATTACKED) return 'このターンは攻撃済みです。';
  const T = cfg.types[cfg.unitType[u]];
  if (s.flags[u] & MOVED) return s.ap < T.attackCost ? `移動済み。攻撃には ${T.attackCost}AP 必要です。` : '移動済み。射程内に敵がいません。';
  if (s.ap === 0) return 'AP がありません。';
  return '射程内に敵がおらず、移動できるマスもありません。';
}

// ---------------------------------------------------------------------------
// 行動履歴・ルール
// ---------------------------------------------------------------------------

function renderLog(game) {
  const el = $('#log');
  if ($('#sheet-log').hidden && el.dataset.n === String(game.log.length)) return;
  el.innerHTML = game.log
    .slice(-200)
    .map((l) => `<li class="${l.cls}">${escapeHTML(l.text)}</li>`)
    .join('');
  el.dataset.n = String(game.log.length);
  el.scrollTop = el.scrollHeight;
}

function renderRules() {
  const rows = UNIT_TYPES.map((T, t) => {
    const n = cfg.roster.filter((x) => x === t).length;
    const note = ['倒されると敗北', '', '命中した敵を 1 マス押し出す。隣接は撃てない。岩で射線が遮られる', '岩を越えて攻撃できる'][t];
    return `<tr><td>${A.emblemIcon(t)} ${T.name}${n > 1 ? ` ×${n}` : ''}</td><td>${T.hp}</td><td>${RANGE_TEXT[t]}</td><td>${T.attackCost}AP</td><td>${note}</td></tr>`;
  }).join('');
  const stages = DICE_STAGES.map((m, i) => `<tr><td>▲${i}${i === 3 ? ' 以上' : ''}</td><td>${i}${i === 3 ? ' 体〜' : ' 体'}</td><td>${m.join('・')}</td><td>1〜${maxAP(i)}AP</td></tr>`).join('');
  $('#rules-body').innerHTML = `
    <h3>勝ち方</h3>
    <p>相手のリーダー（王冠の駒）を倒せば勝ち。40 ラウンドが終わると引き分け。</p>
    <h3>ターンの流れ</h3>
    <ul>
      <li>ダイスを振ると、このターンの AP が決まる（基本 1 ＋ ダイス 3 個の合計）。</li>
      <li>AP の範囲で、好きな駒を好きな順番で動かす。各駒は 1 ターンに移動 1 回・攻撃 1 回。移動 → 攻撃はできるが、攻撃 → 移動はできない。</li>
      <li>使い切れなかった AP は持ち越さない。「ターン終了」で相手の番。</li>
    </ul>
    <h3>被害連動ダイス</h3>
    <p>リーダー以外の味方を失うたびに、<b>次の自軍ターンから</b>ダイスが 1 個ずつ 0〜3 に強化される。振ったダイス・確定した AP は途中で変わらない。</p>
    <table><thead><tr><th>段階</th><th>失った味方</th><th>ダイス</th><th>AP</th></tr></thead><tbody>${stages}</tbody></table>
    <h3>駒</h3>
    <table><thead><tr><th>駒</th><th>HP</th><th>射程</th><th>攻撃</th><th>特徴</th></tr></thead><tbody>${rows}</tbody></table>
    <p>移動は上下左右に 1 マス 1AP。岩・駒のマスは通れない。攻撃は上下左右の直線のみで 1 ダメージ。射線の途中に駒がいると、その先は狙えない。押し出し先が盤の外・岩・駒なら押し出されない（ダメージは入る）。</p>
    <h3>盤面の見かた</h3>
    <ul>
      <li><span class="legend" style="background:#c5ddf2;box-shadow:inset 0 0 0 2px #2f6fd0"></span>青いマス = 移動できる（数字は消費 AP）</li>
      <li><span class="legend" style="background:#f2c8bb;box-shadow:inset 0 0 0 2px #c8321f"></span>赤い鉤形 = 攻撃できる敵</li>
      <li><span class="legend" style="background:#e7dcc2;box-shadow:inset 0 0 0 2px #f1c232"></span>金の枠 = 選択中の駒</li>
      <li><span class="legend" style="background:#3a322b"></span>格子の黒い石板 = 岩（通れない。弓の射線を遮る）</li>
      <li>駒の下の目盛り = HP。左上の印: <b>!</b> 今攻撃できる / <b>➜</b> 移動済み / <b>✓</b> 行動済み。右上の数字 = 同じ職業の 1・2。</li>
      <li>円い台座 = 人間族（あなた）、八角形の台座 = モンスター族（CPU）。盤の四隅の花形（ロゼット）は飾りで、ゲーム上の効果はない。</li>
    </ul>`;
}

// ---------------------------------------------------------------------------
// 結果・シート・通知
// ---------------------------------------------------------------------------

export function showResult(game) {
  const s = game.state;
  const title = $('#result-title');
  if (s.winner === HUMAN) {
    title.textContent = '勝利';
    title.className = 'result-title win';
    $('#result-sub').textContent = `ROUND ${R.roundOf(s)} でモンスター族のリーダーを撃破しました`;
  } else if (s.winner === MONSTER) {
    title.textContent = '敗北';
    title.className = 'result-title lose';
    $('#result-sub').textContent = `ROUND ${R.roundOf(s)} で人間族のリーダーが撃破されました`;
  } else {
    title.textContent = '引き分け';
    title.className = 'result-title';
    $('#result-sub').textContent = `${cfg.rules.maxRounds} ラウンドが終了しました`;
  }
  $('#result').hidden = false;
  $('#btn-again').focus();
}

export function hideResult() {
  $('#result').hidden = true;
}

let toastTimer = 0;
/** 盤面の下部に短い通知を出す（操作は妨げない） */
export function toast(html, cls = '', ms = 2600) {
  const t = $('#toast');
  clearTimeout(toastTimer);
  t.className = 'toast ' + cls;
  t.innerHTML = html;
  t.hidden = false;
  toastTimer = setTimeout(() => {
    t.classList.add('out');
    toastTimer = setTimeout(() => (t.hidden = true), 320);
  }, ms);
}
export function hideToast() {
  clearTimeout(toastTimer);
  $('#toast').hidden = true;
}

export function openSheet(name) {
  closeSheets();
  $('#sheet-back').hidden = false;
  const el = $(`#sheet-${name}`);
  el.hidden = false;
  if (name === 'log') {
    const log = $('#log');
    log.scrollTop = log.scrollHeight;
  }
  const btn = el.querySelector('.sheet-close');
  if (btn) btn.focus();
}
export function closeSheets() {
  document.querySelectorAll('.sheet').forEach((s) => (s.hidden = true));
  $('#sheet-back').hidden = true;
}
export const sheetOpen = () => !$('#sheet-back').hidden;

function escapeHTML(t) {
  return String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}
