// DICE TACTICS 基本形 — ゲームの進行と入力
// ルール判定は src/core/rules.js、CPU は src/core/ai.js（cpu.js 経由で Web Worker）、描画は view.js。

import { makeConfig, HUMAN, MONSTER, LEADER, SIDE_NAMES, unitName } from '../core/config.js';
import { maxAP } from '../core/dice.js';
import * as R from '../core/rules.js';
import { requestPlan } from './cpu.js';
import * as V from './view.js';

const CPU_ROLL_MS = 400; // CPU がダイスを振るまでの間
const CPU_THINK_MIN_MS = 500; // 「CPU の手番」を見せる最短の時間
const CPU_STEP_MS = 450; // CPU の行動を 1 つずつ見せる間隔
const BLOCK_REASON = { edge: '盤の端', obstacle: '岩', unit: 'ユニット' };

const cfg = makeConfig();
const game = {
  state: null, // ルールエンジンの状態（rules.js）
  mode: 'idle', // 'roll'（あなたがダイスを振る）| 'act'（あなたが行動中）| 'cpu' | 'over'
  sel: -1, // 選択中のユニット
  acting: -1, // CPU が動かしたユニット（強調表示）
  trail: [], // CPU の移動経路（強調表示）
  undo: [], // 「移動を戻す」用の状態の履歴（攻撃すると消える）
  log: [], // 行動履歴 [{cls, text}]
  notice: null, // ダイス強化の通知 {text, side}
  error: '', // 直前の操作のエラー
  id: 0, // ゲームの番号（新しいゲームで古い CPU の処理を止める）
};

// ---------------------------------------------------------------------------
// ゲームの進行
// ---------------------------------------------------------------------------

function newGame() {
  const v = document.getElementById('first').value;
  const first = v === 'cpu' ? MONSTER : v === 'random' ? (Math.random() < 0.5 ? HUMAN : MONSTER) : HUMAN;
  game.id++;
  game.state = R.createGame(cfg, { firstSide: first });
  Object.assign(game, { sel: -1, acting: -1, trail: [], undo: [], log: [], notice: null, error: '' });
  V.hideResult();
  log('sys', `新しいゲーム（先手: ${first === HUMAN ? 'あなた' : 'CPU'}）`);
  next();
}

/** 手番の陣営に応じて、ダイス待ち（あなた）か CPU の手番に進む */
function next() {
  const s = game.state;
  if (s.phase === 'over') return finish();
  if (s.side === HUMAN) {
    game.mode = 'roll';
    render();
  } else cpuTurn();
}

function humanRoll() {
  if (game.mode !== 'roll') return;
  game.state = R.beginTurn(game.state, R.rollDiceFor(game.state, Math.random));
  clearNoticeFor(HUMAN);
  logTurnStart();
  game.mode = 'act';
  render();
}

function act(action) {
  if (game.mode !== 'act') return;
  const s = game.state;
  const err = R.validateAction(s, action);
  if (err) {
    game.error = err;
    render();
    return;
  }
  game.error = '';
  if (action.type === 'move') game.undo.push(s);
  else game.undo = []; // 攻撃した後は取り消せない
  const r = R.applyAction(s, action);
  logEvents(r.events, HUMAN);
  announceDiceUp(s, r.state, r.events);
  game.state = r.state;
  if (game.state.phase === 'over') return finish();
  if (game.sel >= 0 && !canStillAct(game.state, game.sel)) game.sel = -1;
  render();
}

function canStillAct(s, u) {
  return R.moveOptions(s, u).length > 0 || R.attackOptions(s, u).length > 0;
}

function undoMove() {
  if (game.mode !== 'act' || game.undo.length === 0) return;
  game.state = game.undo.pop();
  game.error = '';
  log('sys', '移動を取り消しました');
  render();
}

function endHumanTurn() {
  if (game.mode !== 'act') return;
  const left = game.state.ap;
  game.state = R.endTurn(game.state);
  Object.assign(game, { sel: -1, undo: [], error: '' });
  log('sys', `あなたのターン終了${left > 0 ? `（未使用 ${left}AP）` : ''}`);
  next();
}

async function cpuTurn() {
  const id = game.id;
  Object.assign(game, { mode: 'cpu', sel: -1, acting: -1, trail: [] });
  render();
  await sleep(CPU_ROLL_MS);
  if (id !== game.id) return;
  game.state = R.beginTurn(game.state, R.rollDiceFor(game.state, Math.random));
  clearNoticeFor(MONSTER);
  logTurnStart();
  render();
  const t0 = performance.now();
  const plan = await requestPlan(game.state);
  const rest = CPU_THINK_MIN_MS - (performance.now() - t0);
  if (rest > 0) await sleep(rest);
  if (id !== game.id) return;
  for (const a of plan.actions) {
    const s = game.state;
    const r = R.applyAction(s, a);
    game.acting = a.unit;
    game.trail = r.events.filter((e) => e.type === 'move').flatMap((e) => [e.from, ...e.path]);
    logEvents(r.events, MONSTER);
    announceDiceUp(s, r.state, r.events);
    game.state = r.state;
    render();
    if (game.state.phase === 'over') {
      game.acting = -1;
      return finish();
    }
    await sleep(CPU_STEP_MS);
    if (id !== game.id) return;
  }
  Object.assign(game, { acting: -1, trail: [] });
  const left = game.state.ap;
  game.state = R.endTurn(game.state);
  log('sys', `CPU のターン終了${left > 0 ? `（未使用 ${left}AP）` : ''}`);
  next();
}

function finish() {
  const s = game.state;
  game.mode = 'over';
  game.sel = -1;
  log('sys', s.winner === 'draw' ? '引き分け' : s.winner === HUMAN ? 'あなたの勝ち' : 'CPU の勝ち');
  render();
  V.showResult(game);
}

// ---------------------------------------------------------------------------
// 被害連動ダイスの通知
// ---------------------------------------------------------------------------

/** リーダー以外が倒されてダイスが強化されたら、何が変わったかを通知する */
function announceDiceUp(prev, nextState, events) {
  for (const e of events) {
    if (e.type !== 'kill' || cfg.unitType[e.unit] === LEADER) continue;
    const side = cfg.unitSide[e.unit];
    const before = R.diceMaxOf(prev, side);
    const after = R.diceMaxOf(nextState, side);
    const name = unitName(cfg, e.unit);
    const top = maxAP(nextState.lost[side]);
    let text;
    if (after.join() !== before.join()) {
      const st = R.diceStageOf(nextState, side);
      const change = `ダイス強化 ▲${st}：${before.join('・')} → ${after.join('・')}`;
      text = side === HUMAN ? `${name}が倒された！ ${change}（次のターンから 1〜${top}AP）` : `CPU の${name}を撃破！ CPU の${change}（CPU の次のターンから 1〜${top}AP）`;
    } else {
      text = side === HUMAN ? `${name}が倒された（ダイスは最大まで強化済み）` : `CPU の${name}を撃破（CPU のダイスは最大まで強化済み）`;
    }
    game.notice = { text, side };
    log('dice', text);
  }
}

/** 通知は、強化された陣営の次のターンが終わるまで表示する */
function clearNoticeFor(sideStarting) {
  if (game.notice && game.notice.side !== sideStarting) game.notice = null;
}

// ---------------------------------------------------------------------------
// 行動履歴
// ---------------------------------------------------------------------------

function log(cls, text) {
  game.log.push({ cls, text });
}

function logTurnStart() {
  const s = game.state;
  const who = s.side === HUMAN ? 'あなた' : 'CPU';
  log(`turn ${s.side === HUMAN ? 'h' : 'm'}`, `ROUND ${R.roundOf(s)} ${who}: ${s.ap}AP（${s.dice.join('+')}+基本1、ダイス強化▲${R.diceStageOf(s)}）`);
}

function logEvents(events, side) {
  const cls = side === HUMAN ? 'h' : 'm';
  const N = (u) => unitName(cfg, u);
  const C = (c) => R.cellName(c, cfg);
  for (const e of events) {
    if (e.type === 'move') log(cls, `${N(e.unit)} ${C(e.from)}→${C(e.to)}（${e.cost}AP）`);
    else if (e.type === 'attack') log(cls, `${N(e.unit)} → ${N(e.target)} に攻撃（${e.cost}AP${e.overObstacle ? '・岩越し' : ''}）`);
    else if (e.type === 'damage' && e.hp > 0) log(cls, `　└ ${N(e.unit)} 残りHP ${e.hp}`);
    else if (e.type === 'knockback') log(cls, `　└ ${C(e.from)}→${C(e.to)} へ押し出し`);
    else if (e.type === 'knockbackBlocked') log(cls, `　└ 押し出し不可（${BLOCK_REASON[e.reason]}）`);
    else if (e.type === 'kill') log(cls, `　└ ${SIDE_NAMES[cfg.unitSide[e.unit]]}の${N(e.unit)}を撃破！`);
  }
}

// ---------------------------------------------------------------------------
// 入力
// ---------------------------------------------------------------------------

function onCell(c) {
  const s = game.state;
  if (!s) return;
  const u = R.unitAt(s, c);
  if (game.mode === 'act' && game.sel >= 0) {
    if (R.moveOptions(s, game.sel).some((m) => m.cell === c)) return act({ type: 'move', unit: game.sel, to: c });
    if (u >= 0 && cfg.unitSide[u] !== HUMAN && R.attackOptions(s, game.sel).some((a) => a.target === u)) return act({ type: 'attack', unit: game.sel, target: u });
  }
  // ユニットをクリックすると選択（敵は情報の表示のみ）。もう一度クリックか空きマスで解除
  game.error = '';
  game.sel = u >= 0 && u !== game.sel ? u : -1;
  render();
}

function onKey(e) {
  if (e.target && (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT')) return;
  if (e.code === 'Space' || e.code === 'Enter') {
    if (game.mode === 'roll') {
      e.preventDefault();
      humanRoll();
    }
  } else if (e.key === 'e' || e.key === 'E') endHumanTurn();
  else if (e.key === 'z' || e.key === 'Z') undoMove();
  else if (e.key === 'Escape') {
    game.sel = -1;
    render();
  } else if (/^[1-6]$/.test(e.key) && game.state) {
    const u = cfg.sideUnits[HUMAN][+e.key - 1];
    if (game.state.pos[u] >= 0) {
      game.sel = game.sel === u ? -1 : u;
      render();
    }
  }
}

function render() {
  V.render(game);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 起動
// ---------------------------------------------------------------------------

V.initBoard(cfg, onCell);
document.getElementById('btn-new').addEventListener('click', newGame);
document.getElementById('btn-roll').addEventListener('click', humanRoll);
document.getElementById('btn-undo').addEventListener('click', undoMove);
document.getElementById('btn-end').addEventListener('click', endHumanTurn);
document.getElementById('btn-again').addEventListener('click', newGame);
document.getElementById('btn-close').addEventListener('click', V.hideResult);
document.addEventListener('keydown', onKey);
// 動作確認・デバッグ用（ブラウザのコンソールから参照できる）
window.__dt = { game, cfg, act, roll: humanRoll, end: endHumanTurn, newGame };
newGame();
