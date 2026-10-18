// DICE TACTICS 基本形 — 描画
// app.js が持つゲームの状態（game）を受け取り、DOM を書き換えるだけ。ゲームの進行やルール判定はしない。

import { HUMAN, MONSTER, LEADER, ATTACKED, MOVED, unitName, unitShort } from '../core/config.js';
import { BASE_AP, maxAP } from '../core/dice.js';
import * as R from '../core/rules.js';

const $ = (sel) => document.querySelector(sel);
const WHO = ['あなた', 'CPU'];
const TYPE_KEYS = ['leader', 'warrior', 'archer', 'mage'];
const RANGE_TEXT = ['隣接', '隣接', '直線 2〜4 マス', '直線 1〜2 マス（岩を越える）'];

/** 盤面のマスを作る。クリックされたマス番号を onCell に渡す */
export function initBoard(cfg, onCell) {
  const board = $('#board');
  board.innerHTML = '';
  for (let c = 0; c < cfg.CELLS; c++) {
    const el = document.createElement('div');
    const x = c % cfg.W;
    const y = (c / cfg.W) | 0;
    el.className = 'cell' + ((x + y) % 2 ? ' alt' : '') + (cfg.obstacle[c] ? ' rock' : '');
    el.dataset.cell = c;
    board.appendChild(el);
  }
  board.addEventListener('click', (e) => {
    const el = e.target.closest('.cell');
    if (el) onCell(+el.dataset.cell);
  });
}

/** 画面全体を描き直す */
export function render(game) {
  renderBoard(game);
  renderStatus(game);
  renderDice(game);
  renderInfo(game);
  renderLog(game);
}

function renderBoard(game) {
  const s = game.state;
  const cfg = s.cfg;
  const occ = R.occupancy(s);
  // 選択中のユニットの移動先・攻撃対象（自分の行動中のみ）
  const moves = new Map();
  const targets = new Set();
  if (game.mode === 'act' && game.sel >= 0) {
    for (const m of R.moveOptions(s, game.sel)) moves.set(m.cell, m.cost);
    for (const a of R.attackOptions(s, game.sel)) targets.add(a.target);
  }
  const trail = new Set(game.trail || []);
  const cells = $('#board').children;
  for (let c = 0; c < cfg.CELLS; c++) {
    const el = cells[c];
    const u = occ[c];
    el.classList.toggle('move', moves.has(c));
    el.classList.toggle('target', u >= 0 && targets.has(u));
    el.classList.toggle('sel', u >= 0 && u === game.sel);
    el.classList.toggle('acting', u >= 0 && u === game.acting);
    el.classList.toggle('trail', trail.has(c));
    let html = `<span class="coord">${R.cellName(c, cfg)}</span>`;
    if (moves.has(c)) html += `<span class="cost">${moves.get(c)}</span>`;
    if (u >= 0) html += unitHTML(s, u);
    el.innerHTML = html;
  }
}

function unitHTML(s, u) {
  const cfg = s.cfg;
  const t = cfg.unitType[u];
  const side = cfg.unitSide[u];
  const maxHp = cfg.types[t].hp;
  let pips = '';
  for (let i = 0; i < maxHp; i++) pips += `<i class="${i < s.hp[u] ? '' : 'lost'}"></i>`;
  // 手番の陣営で、このターンにもう行動できないユニットは薄く表示
  const done = s.phase === 'act' && side === s.side && (s.flags[u] & ATTACKED || (s.flags[u] & MOVED && s.ap < cfg.types[t].attackCost));
  const cls = `unit ${side === HUMAN ? 'h' : 'm'} ${TYPE_KEYS[t]}${t === LEADER ? ' leader' : ''}${done ? ' done' : ''}`;
  return `<div class="${cls}" title="${side === HUMAN ? '人間族' : 'モンスター族'}の${unitName(cfg, u)}（HP ${s.hp[u]}/${maxHp}）"><span>${unitShort(cfg, u)}</span><span class="hp">${pips}</span></div>`;
}

function renderStatus(game) {
  const s = game.state;
  $('#round').innerHTML = `ROUND <b>${R.roundOf(s)}</b> / ${s.cfg.rules.maxRounds}`;
  const turn = $('#turn');
  if (s.phase === 'over') {
    turn.textContent = s.winner === 'draw' ? '引き分け' : s.winner === HUMAN ? 'あなたの勝ち' : 'CPU の勝ち';
    turn.className = 'turn';
  } else {
    turn.textContent = s.side === HUMAN ? 'あなたの手番' : 'CPU の手番';
    turn.className = 'turn ' + (s.side === HUMAN ? 'h' : 'm');
  }
}

function renderDice(game) {
  const s = game.state;
  const rolled = s.phase === 'act' && s.dice;
  const maxes = rolled ? s.diceMax : R.diceMaxOf(s);
  const values = rolled ? s.dice : maxes.map(() => '?');
  $('#dice').innerHTML = values
    .map((v, i) => `<div class="die${rolled ? '' : ' blank'}${maxes[i] >= 3 ? ' up' : ''}"><div class="face">${v}</div><div class="range">0〜${maxes[i]}</div></div>`)
    .join('');
  const top = maxAP(s.lost[s.side]);
  $('#ap-formula').innerHTML = rolled ? `基本${BASE_AP} + ${s.dice.join(' + ')} = <b>${s.apGained}AP</b>` : `基本${BASE_AP} + ダイス3個<br>（1〜${top}AP）`;
  const bar = [];
  for (let i = 0; i < top; i++) bar.push(`<i class="${rolled && i < s.ap ? 'on' : ''}"></i>`);
  $('#ap-bar').innerHTML = bar.join('');
  $('#ap-text').textContent = rolled ? `残り ${s.ap} / ${s.apGained}` : '';

  // 両陣営のダイス強化段階
  $('#stages').innerHTML = [HUMAN, MONSTER]
    .map((side) => {
      const st = R.diceStageOf(s, side);
      return `<div class="${side === HUMAN ? 'h' : 'm'}"><b>${WHO[side]}</b> ダイス強化 <span class="lv${st > 0 ? ' up' : ''}">▲${st}</span>（${R.diceMaxOf(s, side).join('・')} → 1〜${maxAP(s.lost[side])}AP、失った味方 ${s.lost[side]} 体）</div>`;
    })
    .join('');
  const notice = $('#notice');
  notice.hidden = !game.notice;
  notice.textContent = game.notice ? game.notice.text : '';

  $('#btn-roll').disabled = game.mode !== 'roll';
  $('#btn-undo').disabled = !(game.mode === 'act' && game.undo.length > 0);
  $('#btn-end').disabled = game.mode !== 'act';
}

function renderInfo(game) {
  const s = game.state;
  const msg = $('#message');
  msg.className = 'message' + (game.error ? ' error' : '');
  msg.textContent = game.error || hint(game);
  const info = $('#unit-info');
  const u = game.sel >= 0 ? game.sel : -1;
  if (u < 0 || s.pos[u] < 0) {
    info.innerHTML = '';
    return;
  }
  const cfg = s.cfg;
  const T = cfg.types[cfg.unitType[u]];
  const state = s.flags[u] & ATTACKED ? '攻撃済み' : s.flags[u] & MOVED ? '移動済み（攻撃はできる）' : '未行動';
  info.innerHTML = `<b>${unitName(cfg, u)}</b> HP ${s.hp[u]}/${T.hp} ／ 射程: ${RANGE_TEXT[cfg.unitType[u]]} ／ 攻撃 ${T.attackCost}AP${cfg.unitSide[u] === s.side && s.phase === 'act' ? ` ／ ${state}` : ''}`;
}

function hint(game) {
  const s = game.state;
  if (game.mode === 'roll') return 'ダイスを振って、このターンの AP を決めてください（Space）。';
  if (game.mode === 'cpu') return 'CPU の手番です。';
  if (game.mode === 'over') return 'ゲーム終了。「新しいゲーム」で再開できます。';
  if (game.mode === 'act') {
    if (s.ap === 0) return 'AP を使い切りました。「ターン終了」を押してください（E）。';
    if (game.sel < 0) return '動かすユニットをクリックしてください。';
    return '水色のマスへ移動（数字は消費 AP）、赤い枠の敵を攻撃できます。';
  }
  return '';
}

function renderLog(game) {
  const el = $('#log');
  el.innerHTML = game.log
    .slice(-120)
    .map((l) => `<li class="${l.cls}">${escapeHTML(l.text)}</li>`)
    .join('');
  el.scrollTop = el.scrollHeight;
}

/** 結果画面 */
export function showResult(game) {
  const s = game.state;
  const title = $('#result-title');
  if (s.winner === HUMAN) {
    title.textContent = '勝利！';
    title.className = 'result-title win';
    $('#result-sub').textContent = `ROUND ${R.roundOf(s)} でモンスター族のリーダーを撃破しました`;
  } else if (s.winner === MONSTER) {
    title.textContent = '敗北…';
    title.className = 'result-title lose';
    $('#result-sub').textContent = `ROUND ${R.roundOf(s)} で人間族のリーダーが撃破されました`;
  } else {
    title.textContent = '引き分け';
    title.className = 'result-title';
    $('#result-sub').textContent = `${s.cfg.rules.maxRounds} ラウンドが終了しました`;
  }
  $('#result').hidden = false;
}

export function hideResult() {
  $('#result').hidden = true;
}

function escapeHTML(t) {
  return String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}
