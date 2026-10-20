// DICE TACTICS 基本形 — ゲームの進行と入力
// ルール判定は src/core/rules.js、CPU は src/core/ai.js（cpu.js 経由で Web Worker）、描画は view.js、演出は fx.js。
// UI はコアの関数が返す候補・予測・events を表示するだけで、ルールを自前で計算しない。

import { makeConfig, HUMAN, MONSTER, LEADER, ATTACKED, SIDE_NAMES, unitName } from '../core/config.js';
import { maxAP, meanAP, apDistribution, stageOf } from '../core/dice.js';
import * as R from '../core/rules.js';
import { requestPlan } from './cpu.js';
import { LEVELS, LEVEL_INFO, DEFAULT_LEVEL, PERSONAS, pickPersona } from '../core/levels.js';
import * as V from './view.js';
import * as FX from './fx.js';
import * as AE from './audio/engine.js';
import * as S from './audio/sfx.js';
import * as Music from './audio/music.js';

const BLOCK_REASON = { edge: '盤の端', obstacle: '岩', unit: 'ユニット' };
// CPU の再生速度: anim = 演出の時間の倍率、gap = 行動の間、start = 手番開始からダイスまで
const SPEED = {
  slow: { anim: 1.35, gap: 650, start: 650 },
  normal: { anim: 1, gap: 360, start: 420 },
  fast: { anim: 0.55, gap: 140, start: 200 },
};
const HUMAN_ANIM = 0.85; // あなたの行動の演出は少し速め
const CPU_THINK_MIN_MS = 300;
const ARM_MS = 3200; // 「もう一度押して確定」を待つ時間

const cfg = makeConfig();
const settings = loadSettings();
const game = {
  state: null, // ルールエンジンの状態（rules.js）
  mode: 'idle', // 'roll'（あなたがダイスを振る）| 'act'（あなたが行動中）| 'cpu' | 'over'
  sel: -1, // 選択中のユニット（敵なら情報の表示だけ）
  preview: null, // 確定前の行動案 {kind: 'move'|'attack', ...}
  busy: false, // 演出の再生中（入力を受け付けない）
  acting: -1, // CPU が動かしているユニット
  undo: [], // 「移動を戻す」用の状態の履歴（攻撃すると消える）
  log: [], // 行動履歴 [{cls, text}]
  notice: null, // ダイス強化の通知 {side}
  msg: null, // 直前の操作への短い説明 {text, cls, inspect}
  actNote: '', // 演出中に表示する、確定した行動
  cpuNote: '',
  cpuSub: '',
  cpuThinking: false,
  endArmed: false, // ターン終了の確認待ち
  canAct: true, // まだ行動できる駒があるか
  diceAnimating: false,
  apFresh: false,
  threat: false, // 敵の射程の表示
  threatSet: new Set(),
  inspectThreat: null, // 調べている敵の脅威 {unit, zone, costs, max, avg}
  trails: [], // CPU が直前のターンに動かした経路（あなたがダイスを振るまで残す）
  stats: null, // 終了時の統計（陣営ごと）
  hint: '',
  hintSub: '',
  id: 0, // ゲームの番号（新しいゲームで古い CPU の処理を止める）
};
let armTimer = 0;
let newArmTimer = 0;

const N = (u) => unitName(cfg, u);
const C = (c) => R.cellName(c, cfg);

// ---------------------------------------------------------------------------
// ゲームの進行
// ---------------------------------------------------------------------------

function newGame() {
  FX.cancelAll();
  V.hideToast();
  V.hideResult();
  V.closeSheets();
  V.hideTitle();
  const v = settings.first;
  const first = v === 'cpu' ? MONSTER : v === 'random' ? (Math.random() < 0.5 ? HUMAN : MONSTER) : HUMAN;
  game.id++;
  game.state = R.createGame(cfg, { firstSide: first });
  const level = LEVELS[settings.level] ? settings.level : DEFAULT_LEVEL;
  Object.assign(game, {
    sel: -1,
    preview: null,
    busy: false,
    acting: -1,
    undo: [],
    log: [],
    notice: null,
    msg: null,
    cpuNote: '',
    cpuSub: '',
    cpuThinking: false,
    endArmed: false,
    diceAnimating: false,
    apFresh: false,
    trails: [],
    stats: [newStats(), newStats()],
    level,
    levelInfo: LEVEL_INFO[level],
    cpuPersona: pickPersona(level), // EASY の性格（1 局に 1 つ。ほかの難易度は null）
    cpuPrevStart: null,
    record: null,
    suggest: '',
    personaHint: '',
  });
  disarmNew();
  log('sys', `新しいゲーム（CPU の難易度: ${LEVEL_INFO[level].name}、先手: ${first === HUMAN ? 'あなた' : 'CPU'}）`);
  snd(() => S.stopStinger(0.3));
  snd(() => S.newGame());
  snd(() => Music.restart()); // 設定でオン・消音でなければ曲の頭からかけ直す
  next();
}

/** BGM を鳴らしてよい局面か（設定でオン・消音でない・決着していない） */
const bgmWanted = () => AE.settings.bgm && !AE.settings.mute && game.mode !== 'over';

/** 音を鳴らす（音の失敗でゲームの進行を止めない） */
function snd(fn) {
  try {
    fn();
  } catch (err) {
    console.error('音を省略しました:', err);
  }
}

/** 手番の陣営に応じて、ダイス待ち（あなた）か CPU の手番に進む */
function next() {
  const s = game.state;
  if (s.phase === 'over') return finish();
  if (s.side === HUMAN) {
    game.mode = 'roll';
    snd(() => S.turn(HUMAN));
    render();
  } else cpuTurn();
}

async function humanRoll() {
  if (game.mode !== 'roll' || game.busy) return;
  const id = game.id;
  const s = game.state;
  const dice = R.rollDiceFor(s, Math.random);
  const ns = R.beginTurn(s, dice);
  Object.assign(game, { busy: true, diceAnimating: true, msg: null });
  render();
  await FX.rollDice(dice, ns.diceMax, 1);
  if (id !== game.id) return;
  Object.assign(game, { busy: false, diceAnimating: false, state: ns, apFresh: true, mode: 'act', trails: [] });
  clearNoticeFor(HUMAN);
  logTurnStart();
  if (ns.apGained >= 8) {
    V.toast(`<span class="big">${ns.apGained} AP</span>大きく攻められるターン！`, 'h', 1800);
    snd(() => S.highAP());
  }
  render();
}

async function act(action) {
  if (game.mode !== 'act' || game.busy) return;
  const s = game.state;
  const err = R.validateAction(s, action);
  if (err) return setMsg(err, 'error');
  const r = R.applyAction(s, action);
  if (action.type === 'move') game.undo.push(s);
  else game.undo = []; // 攻撃した後は取り消せない
  disarmEnd();
  game.actNote = describeAction(s, action);
  Object.assign(game, { preview: null, msg: null, apFresh: false, busy: true });
  logEvents(r.events, HUMAN);
  const id = game.id;
  render();
  await FX.playEvents(r.events, { speed: HUMAN_ANIM });
  if (id !== game.id) return;
  game.busy = false;
  game.actNote = '';
  game.state = r.state;
  announceDiceUp(s, r.state, r.events);
  if (game.state.phase === 'over') return finish();
  if (game.sel >= 0 && !canStillAct(game.state, game.sel)) game.sel = -1;
  render();
}

function canStillAct(s, u) {
  return R.moveOptions(s, u).length > 0 || R.attackOptions(s, u).length > 0;
}

async function undoMove() {
  if (game.mode !== 'act' || game.busy || game.undo.length === 0) return;
  const prev = game.undo.pop();
  const cur = game.state;
  const u = cfg.sideUnits[HUMAN].find((x) => cur.pos[x] !== prev.pos[x]);
  const id = game.id;
  disarmEnd();
  Object.assign(game, { preview: null, msg: null, busy: true });
  render();
  snd(() => S.undo());
  if (u !== undefined) await FX.slide(u, cur.pos[u], prev.pos[u], HUMAN_ANIM);
  if (id !== game.id) return;
  Object.assign(game, { busy: false, state: prev, sel: u !== undefined ? u : game.sel });
  log('sys', '移動を取り消しました');
  render();
}

function requestEndTurn() {
  if (game.mode !== 'act' || game.busy) return;
  // まだ動ける駒と AP が残っているときは、もう一度押して確定（誤タップ防止）
  if (!game.endArmed && game.state.ap > 0 && game.canAct) {
    game.endArmed = true;
    snd(() => S.armed());
    clearTimeout(armTimer);
    armTimer = setTimeout(() => {
      game.endArmed = false;
      render();
    }, ARM_MS);
    render();
    return;
  }
  endHumanTurn();
}

function disarmEnd() {
  clearTimeout(armTimer);
  game.endArmed = false;
}

function endHumanTurn() {
  if (game.mode !== 'act' || game.busy) return;
  disarmEnd();
  const left = game.state.ap;
  countUsedAP(game.state);
  game.state = R.endTurn(game.state);
  Object.assign(game, { sel: -1, preview: null, undo: [], msg: null, apFresh: false });
  log('sys', `あなたのターン終了${left > 0 ? `（未使用 ${left}AP）` : ''}`);
  next();
}

async function cpuTurn() {
  const id = game.id;
  const sp = SPEED[settings.speed] || SPEED.normal;
  Object.assign(game, { mode: 'cpu', sel: -1, preview: null, acting: -1, msg: null, cpuNote: 'CPU の手番です。', cpuSub: '', busy: false, apFresh: false, trails: [] });
  snd(() => S.turn(MONSTER));
  render();
  await FX.sleep(sp.start);
  if (id !== game.id) return;
  const s0 = game.state;
  const dice = R.rollDiceFor(s0, Math.random);
  const s1 = R.beginTurn(s0, dice);
  // ダイスの演出中に考え始める。往復防止のため、前の CPU のターンの開始時の駒の位置も渡す
  const planP = requestPlan(s1, { level: game.level, prevStart: game.cpuPrevStart, persona: game.cpuPersona });
  game.cpuPrevStart = Array.from(s1.pos);
  game.diceAnimating = true;
  render();
  await FX.rollDice(dice, s1.diceMax, sp.anim);
  if (id !== game.id) return;
  Object.assign(game, { diceAnimating: false, state: s1, apFresh: true, cpuThinking: true });
  clearNoticeFor(MONSTER);
  logTurnStart();
  game.cpuNote = `CPU は ${s1.ap}AP（基本1 + ${dice.join(' + ')}）`;
  game.cpuSub = 'CPU が考えています…';
  render();
  const t0 = performance.now();
  const plan = await planP;
  const rest = CPU_THINK_MIN_MS * sp.anim - (performance.now() - t0);
  if (rest > 0) await FX.sleep(rest);
  if (id !== game.id) return;
  game.cpuThinking = false;
  const intent = cpuIntent(plan);
  if (intent) log('m', intent);
  game.cpuSub = plan.actions.length === 0 ? 'CPU は動かずにターンを終えます。' : intent;
  render();
  for (const a of plan.actions) {
    const s = game.state;
    Object.assign(game, { acting: a.unit, sel: -1, msg: null, cpuNote: describeAction(s, a), cpuSub: intent, apFresh: false });
    render();
    await FX.sleep(sp.gap * 0.6);
    if (id !== game.id) return;
    const r = R.applyAction(s, a);
    logEvents(r.events, MONSTER);
    game.busy = true;
    await FX.playEvents(r.events, { speed: sp.anim });
    if (id !== game.id) return;
    game.busy = false;
    game.state = r.state;
    for (const e of r.events) if (e.type === 'move') game.trails.push([e.from, ...e.path]);
    game.cpuSub = `CPU の残り ${r.state.ap}AP${intent ? '　' + intent : ''}`;
    announceDiceUp(s, r.state, r.events);
    render();
    if (game.state.phase === 'over') {
      game.acting = -1;
      await FX.sleep(450);
      if (id !== game.id) return;
      return finish();
    }
    await FX.sleep(sp.gap);
    if (id !== game.id) return;
  }
  game.acting = -1;
  const left = game.state.ap;
  countUsedAP(game.state);
  game.state = R.endTurn(game.state);
  log('sys', `CPU のターン終了${left > 0 ? `（未使用 ${left}AP）` : ''}`);
  next();
}

/**
 * CPU の狙い（これから実行する行動列の要約）。予言ではなく、直後に再生する行動を先に短く伝えるだけ。
 * requestPlan の info には狙いの情報がないため、行動列の攻撃対象から作る。
 */
function cpuIntent(plan) {
  if (plan.info && plan.info.reason === 'win') return 'CPU の狙い：あなたのリーダー！';
  const targets = [...new Set(plan.actions.filter((a) => a.type === 'attack').map((a) => a.target))];
  if (targets.length) return `CPU の狙い：あなたの${targets.map(N).join('・')}`;
  if (plan.actions.length) return 'CPU の狙い：位置取り（このターンは攻撃しない）';
  return '';
}

/** 行動の短い説明（演出中の情報行に出す） */
function describeAction(s, a) {
  const cpu = cfg.unitSide[a.unit] === MONSTER;
  if (a.type === 'move') {
    const m = R.moveOptions(s, a.unit).find((o) => o.cell === a.to);
    return `${cpu ? 'CPU：' : ''}${N(a.unit)} が ${C(a.to)} へ移動${m ? `（${m.cost}AP）` : ''}`;
  }
  const o = R.attackOptions(s, a.unit).find((x) => x.target === a.target);
  return `${cpu ? 'CPU：' : ''}${N(a.unit)} が ${cpu ? 'あなたの' : '敵の'}${N(a.target)} を攻撃${o ? `（${o.cost}AP${o.overObstacle ? '・岩越し' : ''}）` : ''}`;
}

function finish() {
  const s = game.state;
  const id = game.id;
  disarmEnd();
  countUsedAP(s);
  Object.assign(game, { mode: 'over', sel: -1, preview: null, busy: false, acting: -1, msg: null });
  log('sys', s.winner === 'draw' ? '引き分け' : s.winner === HUMAN ? 'あなたの勝ち' : 'CPU の勝ち');
  recordResult(s.winner);
  render();
  snd(() => S.result(s.winner === 'draw' ? 'draw' : s.winner === HUMAN ? 'victory' : 'defeat'));
  setTimeout(() => {
    if (id === game.id && game.mode === 'over') V.showResult(game);
  }, 350);
}

// ---------------------------------------------------------------------------
// 被害連動ダイスの通知
// ---------------------------------------------------------------------------

/** リーダー以外が倒されてダイスが強化されたら、何が変わったかを伝える */
function announceDiceUp(prev, nextState, events) {
  let stinger = null;
  for (const e of events) {
    if (e.type !== 'kill' || cfg.unitType[e.unit] === LEADER) continue;
    const side = cfg.unitSide[e.unit];
    const before = R.diceMaxOf(prev, side);
    const after = R.diceMaxOf(nextState, side);
    const st0 = R.diceStageOf(prev, side);
    const st = R.diceStageOf(nextState, side);
    const top0 = maxAP(prev.lost[side]);
    const top = maxAP(nextState.lost[side]);
    const name = N(e.unit);
    const changed = after.join() !== before.join();
    let text;
    let html;
    if (side === HUMAN) {
      text = changed ? `${name}が倒された！ ダイス強化 ▲${st}：${before.join('・')} → ${after.join('・')}（次のターンから 1〜${top}AP）` : `${name}が倒された（ダイスは最大まで強化済み）`;
      html = changed
        ? `<span class="big">ダイス強化 ▲${st0} → ▲${st}</span>${name}を失った… 次のあなたのターンから <b>最大 ${top0} → ${top}AP</b>`
        : `<span class="big">${name}を失った</span>ダイスはすでに最大（1〜${top}AP）`;
    } else {
      text = changed ? `CPU の${name}を撃破！ CPU のダイス強化 ▲${st}：${before.join('・')} → ${after.join('・')}（CPU の次のターンから 1〜${top}AP）` : `CPU の${name}を撃破（CPU のダイスは最大まで強化済み）`;
      html = changed
        ? `<span class="big">CPU の${name}を撃破！</span>CPU のダイスが ▲${st} に強化（次の CPU のターンから 最大 ${top}AP）`
        : `<span class="big">CPU の${name}を撃破！</span>CPU のダイスはすでに最大`;
    }
    game.notice = { side };
    log('dice', text);
    V.toast(html, side === HUMAN ? 'h' : 'm', 3000);
    V.pulseStage(side);
    // 実際に強化されたときだけ、主題を引用したジングル（1 回の行動で 2 体倒れても 1 回）
    if (changed) stinger = side;
  }
  if (stinger !== null) snd(() => S.stageUp(stinger));
}

/** 強化の印は、強化された陣営の次のターンが終わるまで残す */
function clearNoticeFor(sideStarting) {
  if (game.notice && game.notice.side !== sideStarting) game.notice = null;
}

// ---------------------------------------------------------------------------
// 行動履歴
// ---------------------------------------------------------------------------

function log(cls, text) {
  game.log.push({ cls, text });
}

// ---------------------------------------------------------------------------
// 終了時の統計（コアの events と AP から数えるだけ）
// ---------------------------------------------------------------------------

function newStats() {
  return { turns: 0, apSum: 0, apMax: 0, apUsed: 0, attacks: 0, kills: 0, pushes: 0 };
}

/** ターンの終わり（またはゲーム終了時）に、そのターンに使った AP を数える */
function countUsedAP(s) {
  if (game.stats && s.apGained > 0) game.stats[s.side].apUsed += Math.max(0, s.apGained - s.ap);
}

function logTurnStart() {
  const s = game.state;
  const st = game.stats[s.side];
  st.turns++;
  st.apSum += s.ap;
  st.apMax = Math.max(st.apMax, s.ap);
  const who = s.side === HUMAN ? 'あなた' : 'CPU';
  log(`turn ${s.side === HUMAN ? 'h' : 'm'}`, `ROUND ${R.roundOf(s)} ${who}: ${s.ap}AP（${s.dice.join('+')}+基本1、ダイス強化▲${R.diceStageOf(s)}）`);
}

function logEvents(events, side) {
  const cls = side === HUMAN ? 'h' : 'm';
  const st = game.stats[side];
  for (const e of events) {
    if (e.type === 'attack') st.attacks++;
    else if (e.type === 'kill') st.kills++;
    else if (e.type === 'knockback') st.pushes++;
    if (e.type === 'move') log(cls, `${N(e.unit)} ${C(e.from)}→${C(e.to)}（${e.cost}AP）`);
    else if (e.type === 'attack') log(cls, `${N(e.unit)} → ${N(e.target)} に攻撃（${e.cost}AP${e.overObstacle ? '・岩越し' : ''}）`);
    else if (e.type === 'damage' && e.hp > 0) log(cls, `　└ ${N(e.unit)} 残りHP ${e.hp}`);
    else if (e.type === 'knockback') log(cls, `　└ ${C(e.from)}→${C(e.to)} へ押し出し`);
    else if (e.type === 'knockbackBlocked') log(cls, `　└ 押し出し不可（${BLOCK_REASON[e.reason]}）`);
    else if (e.type === 'kill') log(cls, `　└ ${SIDE_NAMES[cfg.unitSide[e.unit]]}の${N(e.unit)}を撃破！`);
  }
}

// ---------------------------------------------------------------------------
// 行動案（タップでプレビュー → 同じ対象をもう一度タップで確定）
// ---------------------------------------------------------------------------

function movePreview(m) {
  const s = game.state;
  const u = game.sel;
  const T = cfg.types[cfg.unitType[u]];
  const left = s.ap - m.cost;
  const total = m.cost + T.attackCost;
  const canAttackAfter = !(s.flags[u] & ATTACKED) && left >= T.attackCost;
  // 移動先から射線が通る敵（コアの attackTargetsFrom は u の現在マスを空きとして扱う）。AP が足りなくても候補は示す
  const reach = s.flags[u] & ATTACKED ? [] : R.attackTargetsFrom(s, u, m.cell, R.occupancy(s)).map((t) => t.target);
  const after = canAttackAfter ? reach : [];
  const short = canAttackAfter ? [] : reach;
  const names = (list) => list.map((t) => N(t) + (s.hp[t] <= 1 ? '<span class="em-kill">（撃破可）</span>' : '')).join('・');
  const sum = `移動${m.cost}＋攻撃${T.attackCost}＝<b>計${total}AP</b>`;
  let sub;
  if (after.length) sub = `移動後に狙える：<b>${names(after)}</b>　${sum}`;
  else if (short.length) sub = `<span class="em-warn">AP 不足</span>：${names(short)} を狙うには ${sum}（今は ${s.ap}AP）`;
  else sub = '移動先から狙える敵はいません';
  if (game.threat) {
    const hs = R.applyAction(s, { type: 'move', unit: u, to: m.cell }).state;
    if (threatened(hs, HUMAN).has(u)) sub += '　<span class="em-warn">⚠ 移動先は敵の射程内</span>';
  }
  return {
    kind: 'move',
    cell: m.cell,
    from: s.pos[u],
    path: m.path,
    after,
    short,
    action: { type: 'move', unit: u, to: m.cell },
    text: `${N(u)} → ${C(m.cell)} へ移動 <b>${m.cost}AP</b>（残り${left}）`,
    sub: sub + '　<span class="hint-tap">再タップで確定</span>',
  };
}

function attackPreview(a) {
  const s = game.state;
  const u = game.sel;
  const t = a.target;
  const hp = s.hp[t];
  let sub;
  if (a.hit.kills) {
    if (cfg.unitType[t] === LEADER) sub = '<b class="em-kill">リーダー撃破で勝利！</b>';
    else {
      const st = R.diceStageOf(s, MONSTER);
      const st2 = stageOf(s.lost[MONSTER] + 1);
      sub = `<b class="em-kill">撃破！</b>${st2 > st ? `（CPU のダイスが ▲${st} → ▲${st2} に強化される）` : ''}`;
    }
  } else {
    sub = `HP ${hp} → ${hp - 1}`;
    if (a.hit.knockback) sub += a.hit.dest >= 0 ? `・<b>${C(a.hit.dest)} へ押し出す</b>` : `・押し出し不可（${BLOCK_REASON[a.hit.blocked]}）`;
  }
  return {
    kind: 'attack',
    target: t,
    opt: a,
    action: { type: 'attack', unit: u, target: t },
    text: `${N(u)} → ${N(t)} を攻撃 <b>${a.cost}AP</b>${a.overObstacle ? '・岩越し' : ''}（残り${s.ap - a.cost}）`,
    sub: sub + '　<span class="hint-tap">再タップで確定</span>',
  };
}

function confirmPreview() {
  if (!game.preview || game.busy) return;
  act(game.preview.action);
}

function setMsg(text, cls = '', inspect = -1) {
  game.msg = { text, cls, inspect };
  if (cls === 'error') snd(() => S.error());
  render();
}

// ---------------------------------------------------------------------------
// 入力
// ---------------------------------------------------------------------------

function onCell(c) {
  const s = game.state;
  if (!s || game.busy) return;
  const u = R.unitAt(s, c);
  const prevInspect = game.msg ? game.msg.inspect : -1;
  game.msg = null;
  const mine = game.mode === 'act' && game.sel >= 0 && cfg.unitSide[game.sel] === HUMAN;
  // 攻撃できない敵をもう一度タップしたら、その敵を調べる（脅威の表示）
  if (mine && u >= 0 && u === prevInspect) {
    game.preview = null;
    game.sel = u;
    snd(() => S.select());
    return render();
  }
  if (mine) {
    const pv = game.preview;
    // 同じ対象をもう一度タップ → 確定
    if (pv && ((pv.kind === 'move' && pv.cell === c) || (pv.kind === 'attack' && u === pv.target))) return confirmPreview();
    const m = R.moveOptions(s, game.sel).find((o) => o.cell === c);
    if (m) {
      if (settings.quick) return act(m && { type: 'move', unit: game.sel, to: c });
      game.preview = movePreview(m);
      snd(() => S.preview('move'));
      return render();
    }
    if (u >= 0 && cfg.unitSide[u] !== HUMAN) {
      const a = R.attackOptions(s, game.sel).find((o) => o.target === u);
      if (a) {
        game.preview = attackPreview(a);
        snd(() => S.preview('attack'));
        return render();
      }
      // 攻撃できない理由（コアの判定文）
      game.preview = null;
      return setMsg((R.validateAction(s, { type: 'attack', unit: game.sel, target: u }) || '攻撃できません') + '（もう一度タップでこの敵を調べる）', 'error', u);
    }
    if (u < 0) {
      if (pv) {
        game.preview = null;
        return render();
      }
      if (R.canMove(s, game.sel)) return setMsg(R.validateAction(s, { type: 'move', unit: game.sel, to: c }) || '移動できません', 'error');
    }
  }
  // 駒をタップすると選択（敵は情報の表示のみ）。もう一度タップか空きマスで解除
  game.preview = null;
  game.sel = u >= 0 && u !== game.sel ? u : -1;
  if (game.sel >= 0) snd(() => S.select());
  render();
}

function selectOwn(k) {
  if (!game.state || game.busy) return;
  const u = cfg.sideUnits[HUMAN][k];
  if (game.state.pos[u] < 0) return;
  game.preview = null;
  game.msg = null;
  game.sel = game.sel === u ? -1 : u;
  if (game.sel >= 0) snd(() => S.select());
  render();
}

function cancel() {
  if (game.busy) return;
  if (game.preview) game.preview = null;
  else game.sel = -1;
  game.msg = null;
  render();
}

function onMain() {
  if (game.busy) return;
  if (game.mode === 'roll') humanRoll();
  else if (game.mode === 'act') requestEndTurn();
  else if (game.mode === 'over') newGame();
}

function onKey(e) {
  const tag = e.target && e.target.tagName;
  if (tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA') return;
  // キーの押しっぱなし（自動リピート）は無視する（「もう一度押して確定」を飛ばさないように）
  if (e.repeat) {
    if (e.key === 'Enter' || e.code === 'Space') e.preventDefault();
    return;
  }
  // タイトル画面: 1〜4 で難易度を選び、Enter / Space ではじめる（フォーカス中のボタンはそのボタンに任せる）
  if (V.titleOpen()) {
    const keys = Object.keys(LEVELS);
    if (/^[1-9]$/.test(e.key) && keys[+e.key - 1]) {
      titleLevel = keys[+e.key - 1];
      renderTitle();
    } else if ((e.key === 'Enter' || e.code === 'Space') && tag !== 'BUTTON') {
      e.preventDefault();
      startFromTitle();
    }
    return;
  }
  if (e.key === 'Escape') {
    if (V.sheetOpen()) V.closeSheets();
    else if (!document.getElementById('result').hidden) V.hideResult();
    else cancel();
    return;
  }
  if (V.sheetOpen() || !document.getElementById('result').hidden) return;
  const onButton = tag === 'BUTTON';
  if (e.code === 'Space') {
    if (onButton) return; // フォーカス中のボタンに任せる
    if (game.mode === 'roll') {
      e.preventDefault();
      humanRoll();
    }
  } else if (e.key === 'Enter') {
    if (onButton) return;
    if (game.preview) {
      e.preventDefault();
      confirmPreview();
    } else if (game.mode === 'roll') {
      e.preventDefault();
      humanRoll();
    }
  } else if (e.key === 'e' || e.key === 'E') requestEndTurn();
  else if (e.key === 'z' || e.key === 'Z') undoMove();
  else if (/^[1-6]$/.test(e.key)) selectOwn(+e.key - 1);
}

// ---------------------------------------------------------------------------
// 局面のヒント・敵の射程
// ---------------------------------------------------------------------------

/**
 * 敵が「平均的な AP」で次のターンに攻撃できる side の駒。
 * 1 体が移動してから攻撃する場合だけを、コアの reachable / attackTargetsFrom で調べる。
 */
function threatened(s, side) {
  const out = new Set();
  if (s.phase === 'over') return out;
  const enemy = side ^ 1;
  const budget = threatBudget(s, enemy);
  for (const e of cfg.sideUnits[enemy]) for (const t of attackCosts(s, e, budget).costs.keys()) out.add(t);
  return out;
}

/**
 * 駒 e が次のターンに、移動してから攻撃する場合に必要な最小 AP（相手の駒ごと）と、攻撃前に移動しうるマス。
 * ほかの駒は今の位置のまま動かないと仮定した「可能性」で、コアの reachable / attackTargetsFrom だけで求める。
 */
function attackCosts(s, e, budget) {
  const costs = new Map();
  const zone = new Set();
  const T = cfg.types[cfg.unitType[e]];
  if (s.pos[e] < 0 || budget < T.attackCost) return { costs, zone };
  const occ = R.occupancy(s);
  const { dist } = R.reachable(s, e, budget - T.attackCost);
  for (let c = 0; c < cfg.CELLS; c++) {
    if (dist[c] < 0) continue;
    zone.add(c);
    const cost = dist[c] * cfg.rules.moveCost + T.attackCost;
    for (const t of R.attackTargetsFrom(s, e, c, occ)) {
      if (cfg.unitSide[t.target] === cfg.unitSide[e]) continue;
      if (!costs.has(t.target) || costs.get(t.target) > cost) costs.set(t.target, cost);
    }
  }
  return { costs, zone };
}

/** 調べている敵の脅威（次のターンの最大 AP での可能性） */
function inspectThreat(s, u) {
  if (u < 0 || s.pos[u] < 0 || cfg.unitSide[u] !== MONSTER || s.phase === 'over') return null;
  const max = maxAP(s.lost[MONSTER]);
  const { costs, zone } = attackCosts(s, u, max);
  return { unit: u, zone, costs, max, avg: threatBudget(s, MONSTER) };
}

/** 自軍リーダーを、どれかの敵が攻撃しうる最小 AP（いなければ null） */
function leaderDanger(s) {
  const L = cfg.leaderOf[HUMAN];
  let best = null;
  for (const e of cfg.sideUnits[MONSTER]) {
    const c = attackCosts(s, e, maxAP(s.lost[MONSTER])).costs.get(L);
    if (c !== undefined && (best === null || c < best)) best = c;
  }
  return best;
}
// 平均 AP の小数部は切り捨てる（4.0 が浮動小数点の誤差で 3.999… にならないよう微小値を足す）
const threatBudget = (s, side) => Math.floor(meanAP(apDistribution(s.lost[side])) + 1e-9);

// ROOKIE の最初の 3 ラウンドだけ、情報行に操作のヒントを 1 行ずつ出す（読まなくても遊べる。チュートリアルではない）
const ROOKIE_TIPS = [
  'ヒント：AP は 6 体みんなで使います。移動は 1 マス 1AP、攻撃は王・戦士 1AP、弓・魔 2AP',
  'ヒント：弓は 2〜4 マス先を撃てて、当てた敵を 1 マス押し出します（隣の敵は撃てません）',
  'ヒント：魔法は岩を越えて 2 マス先まで届きます。敵の駒をタップすると、その敵の届く範囲が見られます',
];
function rookieTip(s) {
  const r = R.roundOf(s);
  return game.level === 'rookie' && r >= 1 && r <= ROOKIE_TIPS.length ? `<span class="tip">${ROOKIE_TIPS[r - 1]}</span>` : '';
}

function computeHints() {
  const s = game.state;
  let hint = '';
  let sub = '';
  let canAct = false;
  const tip = rookieTip(s);
  if (game.mode === 'roll') {
    const st = R.diceStageOf(s, HUMAN);
    hint = 'ダイスを振って、このターンの AP を決めましょう。';
    sub = game.notice && game.notice.side === HUMAN ? `<span class="em-kill">ダイスが ▲${st} に強化されています — 最大 ${maxAP(s.lost[HUMAN])}AP！</span>` : tip || `▲${st}：ダイス ${R.diceMaxOf(s, HUMAN).join('・')} → 1〜${maxAP(s.lost[HUMAN])}AP`;
  } else if (game.mode === 'act') {
    const ready = [];
    for (const u of cfg.sideUnits[HUMAN]) {
      if (s.pos[u] < 0) continue;
      const atk = R.attackOptions(s, u).length > 0;
      if (atk) ready.push(N(u));
      if (atk || R.moveOptions(s, u).length > 0) canAct = true;
    }
    if (s.ap === 0) hint = 'AP を使い切りました。「ターン終了」へ。';
    else if (!canAct) hint = 'もう動ける駒がありません。「ターン終了」へ。';
    else {
      hint = `残り ${s.ap}AP：動かす駒をタップ`;
      if (ready.length) sub = `今すぐ攻撃できる：<b>${ready.join('・')}</b>（左上に <b>!</b>）`;
      else if (s.ap <= 2) sub = `AP ${s.ap} でできること：${s.ap === 1 ? '1 マス移動、または王・戦士の攻撃' : '2 マス移動、または攻撃 1 回（弓・魔は 2AP）'}`;
      else sub = tip || '攻撃できる敵はいません。移動で位置を整えましょう。';
    }
  }
  if (game.threat && (game.mode === 'roll' || game.mode === 'act')) {
    const n = game.threatSet.size;
    const ld = leaderDanger(s);
    sub =
      `<span class="em-warn">敵の射程：狙われる味方 ${n} 体</span>（CPU の平均 ${threatBudget(s, MONSTER)}AP）・王を狙える最小 ${ld === null ? `—（最大 ${maxAP(s.lost[MONSTER])}AP でも届かない）` : `${ld}AP`}` +
      (sub ? '　' + sub : '');
  }
  game.hint = hint;
  game.hintSub = sub;
  game.canAct = canAct;
}

function render() {
  game.threatSet = game.threat && game.state ? threatened(game.state, HUMAN) : new Set();
  game.inspectThreat = game.state && !game.preview ? inspectThreat(game.state, game.msg && game.msg.inspect >= 0 ? -1 : game.sel) : null;
  computeHints();
  V.render(game);
}

// ---------------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------------

/**
 * 設定を読む。難易度（level）の既定は、はじめての人なら ROOKIE、これまで遊んでいた人（設定は保存されているが
 * 難易度がない）なら HARD（= これまでの CPU。知らないうちに強さが変わらないように）。
 */
function loadSettings() {
  const def = { first: 'human', speed: 'normal', quick: false, calm: false };
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem('dice-tactics.settings') || 'null');
  } catch {
    saved = null;
  }
  const s = { ...def, ...(saved || {}) };
  if (!LEVELS[s.level]) {
    s.level = saved ? 'hard' : DEFAULT_LEVEL; // はじめての人は ROOKIE、難易度のなかった頃の設定はこれまでの CPU
    s.levelTag = saved ? 'いままでと同じ強さ' : 'はじめての方に';
  }
  return s;
}

// ---------------------------------------------------------------------------
// 難易度ごとの戦績
// ---------------------------------------------------------------------------

const RECORD_KEY = 'dice-tactics.records';
function loadRecords() {
  try {
    return JSON.parse(localStorage.getItem(RECORD_KEY) || '{}') || {};
  } catch {
    return {};
  }
}
function recordResult(winner) {
  const recs = loadRecords();
  const r = (recs[game.level] ||= { w: 0, l: 0, d: 0 });
  if (winner === HUMAN) r.w++;
  else if (winner === 'draw') r.d++;
  else r.l++;
  try {
    localStorage.setItem(RECORD_KEY, JSON.stringify(recs));
  } catch {
    // 保存できない環境では記録しない
  }
  game.record = r;
  // EASY は、対局の後で CPU の思い違い（性格）を明かす。次の対局の作戦につながるように
  game.personaHint = game.cpuPersona && PERSONAS[game.cpuPersona] ? PERSONAS[game.cpuPersona].hint : '';
  // 勝ち越してきたら、ひとつ上の難易度をすすめる
  const order = Object.keys(LEVELS);
  const up = order[order.indexOf(game.level) + 1];
  game.suggest = winner === HUMAN && up && r.w >= 3 && r.w > r.l ? `「${LEVEL_INFO[game.level].name}」で ${r.w} 勝しました。次は「${LEVEL_INFO[up].name}」に挑戦してみませんか？（タイトルで選べます）` : '';
}

// ---------------------------------------------------------------------------
// タイトル画面
// ---------------------------------------------------------------------------

let titleLevel = settings.level;

function renderTitle() {
  const recs = loadRecords();
  // 勝ち越している難易度の 1 つ上に「挑戦」の印を付ける（はじめての人・これまでの人の印が優先）
  let tag = settings.levelTag ? { level: settings.level, text: settings.levelTag } : null;
  if (!tag) {
    const order = Object.keys(LEVELS);
    for (let i = 0; i < order.length - 1; i++) {
      const r = recs[order[i]];
      if (r && r.w >= 3 && r.w > r.l && !(recs[order[i + 1]] && recs[order[i + 1]].w + recs[order[i + 1]].l > 0)) tag = { level: order[i + 1], text: '挑戦してみよう' };
    }
  }
  const maxStars = Math.max(...Object.values(LEVEL_INFO).map((i) => i.stars));
  V.renderTitle({ levels: Object.keys(LEVELS), info: LEVEL_INFO, maxStars, selected: titleLevel, first: settings.first, records: recs, tag });
}

/** タイトル画面を出す（対局は止める） */
function goTitle() {
  FX.cancelAll();
  game.id++; // 進行中の CPU の手番を止める
  Object.assign(game, { mode: 'title', busy: false, sel: -1, preview: null, acting: -1, msg: null });
  disarmEnd();
  disarmNew();
  V.hideResult();
  V.closeSheets();
  V.hideToast();
  snd(() => S.stopStinger(0.2));
  if (!game.state) game.state = R.createGame(cfg, { firstSide: HUMAN });
  titleLevel = LEVELS[settings.level] ? settings.level : DEFAULT_LEVEL;
  renderTitle();
  render();
  V.showTitle();
}

/** タイトル画面の「対局をはじめる」 */
function startFromTitle() {
  settings.level = titleLevel;
  delete settings.levelTag;
  saveSettings();
  newGame();
}
function saveSettings() {
  try {
    localStorage.setItem('dice-tactics.settings', JSON.stringify(settings));
  } catch {
    // 保存できない環境では、このページを開いている間だけ有効
  }
}

function applySettingsUI() {
  document.querySelectorAll('#set-speed button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.v === settings.speed)));
  document.getElementById('set-quick').checked = settings.quick;
  document.getElementById('set-calm').checked = settings.calm;
  document.body.classList.toggle('calm', settings.calm);
  FX.setCalm(settings.calm);
  const a = AE.settings;
  document.getElementById('set-sfx').checked = a.sfx;
  document.getElementById('set-sfx-vol').value = Math.round(a.sfxVol * 100);
  document.getElementById('set-sfx-vol').disabled = !a.sfx;
  document.getElementById('set-bgm').checked = a.bgm;
  document.getElementById('set-bgm-vol').value = Math.round(a.bgmVol * 100);
  document.getElementById('set-bgm-vol').disabled = !a.bgm;
  // 消音ボタン: 表示の文言は「消音」のまま、状態は aria-pressed と色・アイコンで示す
  const mute = document.getElementById('btn-mute');
  mute.setAttribute('aria-pressed', String(a.mute));
  mute.querySelector('.aux-ico').textContent = a.mute ? '×' : '♪';
  // BGM を書き出せない環境ではオンにできない
  if (!Music.supported()) {
    document.getElementById('set-bgm').disabled = true;
    document.getElementById('set-bgm-vol').disabled = true;
  }
}

/** 音の設定を変えたら、保存して音量・BGM に反映する（決着後は BGM を再開しない） */
function applyAudio() {
  AE.saveSettings();
  AE.applyVolumes();
  if (bgmWanted()) Music.start();
  else Music.stop(0.6);
  // 消音したとき、効果音も BGM もオフにしたときは、鳴っているジングルも止める
  if (AE.settings.mute || (!AE.settings.sfx && !AE.settings.bgm)) snd(() => S.stopStinger(0.1));
  applySettingsUI();
}

/** 新しいゲーム: 対局の途中なら、もう一度押して確定 */
function onNewGame() {
  const btn = document.getElementById('btn-new');
  const inProgress = game.mode !== 'over' && (game.state.turn > 1 || game.mode === 'act');
  if (inProgress && !btn.classList.contains('armed')) {
    btn.classList.add('armed');
    btn.textContent = '対局を破棄してタイトルへ？（もう一度押す）';
    clearTimeout(newArmTimer);
    newArmTimer = setTimeout(disarmNew, ARM_MS);
    return;
  }
  goTitle();
}
function disarmNew() {
  clearTimeout(newArmTimer);
  const btn = document.getElementById('btn-new');
  btn.classList.remove('armed');
  btn.textContent = 'タイトルに戻る（新しいゲーム）';
}

// ---------------------------------------------------------------------------
// 起動
// ---------------------------------------------------------------------------

V.init(cfg, onCell);
FX.init(cfg);
applySettingsUI();

document.getElementById('btn-main').addEventListener('click', onMain);
document.getElementById('btn-undo').addEventListener('click', undoMove);
document.getElementById('btn-confirm').addEventListener('click', confirmPreview);
document.getElementById('btn-again').addEventListener('click', newGame);
document.getElementById('btn-close').addEventListener('click', V.hideResult);
document.getElementById('btn-title').addEventListener('click', goTitle);
document.getElementById('btn-new').addEventListener('click', onNewGame);
// タイトル画面: 難易度・先手を選んで「対局をはじめる」
document.getElementById('title-levels').addEventListener('click', (e) => {
  const b = e.target.closest('.level-btn');
  if (!b) return;
  titleLevel = b.dataset.level;
  snd(() => S.select());
  renderTitle();
});
document.querySelectorAll('#title-first button').forEach((b) =>
  b.addEventListener('click', () => {
    settings.first = b.dataset.v;
    saveSettings();
    snd(() => S.select());
    renderTitle();
  }),
);
document.getElementById('btn-start').addEventListener('click', startFromTitle);
document.getElementById('btn-threat').addEventListener('click', (e) => {
  game.threat = !game.threat;
  e.currentTarget.setAttribute('aria-pressed', String(game.threat));
  if (!game.busy) render();
});
document.querySelectorAll('[data-sheet]').forEach((b) => b.addEventListener('click', () => V.openSheet(b.dataset.sheet)));
document.querySelectorAll('.sheet-close').forEach((b) => b.addEventListener('click', V.closeSheets));
document.getElementById('sheet-back').addEventListener('click', V.closeSheets);
document.querySelectorAll('#set-speed button').forEach((b) =>
  b.addEventListener('click', () => {
    settings.speed = b.dataset.v;
    saveSettings();
    applySettingsUI();
  }),
);
document.getElementById('set-quick').addEventListener('change', (e) => {
  settings.quick = e.target.checked;
  saveSettings();
});
document.getElementById('set-calm').addEventListener('change', (e) => {
  settings.calm = e.target.checked;
  saveSettings();
  applySettingsUI();
});
document.addEventListener('keydown', onKey);

// 音: 設定と、最初の操作での再生開始（ブラウザの自動再生の制限のため）
document.getElementById('set-sfx').addEventListener('change', (e) => {
  AE.settings.sfx = e.target.checked;
  applyAudio();
  snd(() => S.select());
});
document.getElementById('set-sfx-vol').addEventListener('input', (e) => {
  AE.settings.sfxVol = +e.target.value / 100;
  AE.applyVolumes();
});
document.getElementById('set-sfx-vol').addEventListener('change', () => {
  applyAudio();
  snd(() => S.select());
});
document.getElementById('set-bgm').addEventListener('change', (e) => {
  AE.settings.bgm = e.target.checked;
  applyAudio();
});
document.getElementById('set-bgm-vol').addEventListener('input', (e) => {
  AE.settings.bgmVol = +e.target.value / 100;
  AE.applyVolumes();
});
document.getElementById('set-bgm-vol').addEventListener('change', applyAudio);
document.getElementById('btn-mute').addEventListener('click', () => {
  AE.settings.mute = !AE.settings.mute;
  applyAudio();
});
// タッチ端末では pointerdown では再生が許可されないため、pointerup / touchend / click でも呼ぶ。
// iOS の通話・画面ロックなどで止まった AudioContext も次の操作で再開できるよう、リスナーは外さない
// （中身は状態を見て必要なときだけ resume する軽い処理）。Web Audio が使えない環境では外す。
const UNLOCK_EVENTS = ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown'];
const unlockAudio = () => {
  AE.unlock();
  if (AE.unavailable()) for (const t of UNLOCK_EVENTS) document.removeEventListener(t, unlockAudio, true);
};
for (const t of UNLOCK_EVENTS) document.addEventListener(t, unlockAudio, true);
// BGM の書き出しに失敗したら、設定画面の BGM をオンにできない表示にする
Music.onFail(() => applySettingsUI());
AE.onUnlock(() => {
  // 書き出しなどの重い処理は入力のイベントの外で行う
  setTimeout(() => {
    if (bgmWanted()) snd(() => Music.start());
    const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 200));
    idle(() => snd(() => S.warm()));
  }, 0);
});
applySettingsUI();

// 動作確認・デバッグ用（ブラウザのコンソールから参照できる）
window.__dt = { game, cfg, settings, act, roll: humanRoll, end: endHumanTurn, newGame, goTitle, startFromTitle, R, audio: { AE, S, Music } };
// 起動するとタイトル画面を出す（盤面は初期配置のまま後ろに見せる）
goTitle();
