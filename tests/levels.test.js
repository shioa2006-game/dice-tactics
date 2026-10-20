// 難易度のテスト（ROOKIE・EASY・NORMAL・HARD）
//   HARD = これまでの CPU（標準）が 1 手も変わっていないこと（照合データ tests/fixtures/standard-golden.json）
//   EASY・NORMAL が ROOKIE の追加前と 1 手も変わっていないこと（照合データ tests/fixtures/levels-golden.json）
//   ROOKIE は別の考え方（planRookie）で指す。合法・目の前の勝ちや攻撃を逃さない・対局が終わる・速い、を確かめる
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeConfig, HUMAN, MONSTER } from '../src/core/config.js';
import * as R from '../src/core/rules.js';
import { planTurn, CPU, cappedDist, pickNearBest, WIN_SCORE } from '../src/core/ai.js';
import { apDistribution } from '../src/core/dice.js';
import { LEVELS, LEVEL_INFO, DEFAULT_LEVEL, PERSONAS, cpuFor, pickPersona, planLevel } from '../src/core/levels.js';
import { makeRng } from '../src/core/rng.js';
import { board } from './helpers.js';

const cfg = makeConfig();
const GOLDEN = JSON.parse(readFileSync(new URL('./fixtures/standard-golden.json', import.meta.url), 'utf8'));

function unpack(p, ap = p.ap) {
  const s = R.createGame(cfg, { firstSide: p.firstSide });
  s.pos = Int8Array.from(p.pos);
  s.hp = Int8Array.from(p.hp);
  s.flags = Uint8Array.from(p.flags);
  s.side = p.side;
  s.turn = p.turn;
  s.lost = p.lost.slice();
  s.phase = 'act';
  s.ap = ap;
  s.apGained = ap;
  return s;
}

/** 照合データの対局を、指定した計画関数で指し直して比べる */
function replayGames(plan) {
  for (const g of GOLDEN.games) {
    let s = R.createGame(cfg, { firstSide: g.firstSide });
    g.turns.forEach((turn, t) => {
      s = R.beginTurn(s, turn.dice);
      const p = plan(s, makeRng(g.seed * 1000 + t));
      if (p.info.timeCut) return; // 遅い環境で時間切れが起きた手は比べられない
      assert.deepEqual(p.actions, turn.actions, `game ${g.seed} turn ${t}`);
      for (const a of p.actions) s = R.applyAction(s, a).state;
      if (s.phase !== 'over') s = R.endTurn(s);
    });
    assert.equal(s.winner, g.winner);
  }
}

describe('むずかしい（これまでの CPU）が変わっていない', () => {
  test('照合データの対局を 1 手も違わずに指す', () => {
    replayGames((s, rng) => planTurn(s, { rng }));
  });

  test('照合データの局面（AP 1〜10）で同じ行動列を選ぶ', () => {
    for (const c of GOLDEN.cases) {
      const p = planTurn(unpack(c.state, c.ap), { rng: makeRng(c.rngSeed) });
      if (p.info.timeCut) continue;
      assert.deepEqual(p.actions, c.actions, `case game ${c.game} turn ${c.turn} ap ${c.ap}`);
    }
  });

  test('CPU（標準）の設定項目が増えていない', () => {
    assert.deepEqual(Object.keys(CPU), GOLDEN.cpuKeys);
  });

  test('むずかしいは CPU オブジェクトそのもので、planLevel でも照合データと一致する', () => {
    assert.equal(LEVELS.hard, CPU);
    replayGames((s, rng) => planLevel(s, { level: 'hard', rng }));
  });
});

describe('やさしい・ふつうが変わっていない（照合データ tests/fixtures/levels-golden.json）', () => {
  const LG = JSON.parse(readFileSync(new URL('./fixtures/levels-golden.json', import.meta.url), 'utf8'));
  for (const set of LG.sets) {
    const name = `${set.level}${set.persona ? `（${set.persona}）` : ''}`;
    test(`${name}: 照合データの局面（AP 1〜10）で同じ行動列を選ぶ`, () => {
      for (const c of set.cases) {
        const p = planLevel(unpack(GOLDEN.cases[c.idx].state, c.ap), { level: set.level, persona: set.persona, rng: makeRng(c.rngSeed) });
        if (p.info.timeCut) continue;
        assert.deepEqual(p.actions, c.actions, `case ${c.idx} ap ${c.ap}`);
      }
    });
    test(`${name}: 照合データの対局を 1 手も違わずに指す（往復防止の prevStart つき）`, () => {
      const g = set.game;
      let s = R.createGame(cfg, { firstSide: g.firstSide });
      const prev = [null, null];
      g.turns.forEach((turn, t) => {
        s = R.beginTurn(s, turn.dice);
        const p = planLevel(s, { level: set.level, persona: set.persona, rng: makeRng(g.seed * 1000 + t), prevStart: prev[s.side] });
        prev[s.side] = Array.from(s.pos);
        if (p.info.timeCut) return;
        assert.deepEqual(p.actions, turn.actions, `turn ${t}`);
        for (const a of p.actions) s = R.applyAction(s, a).state;
        if (s.phase !== 'over') s = R.endTurn(s);
      });
      assert.equal(s.winner, g.winner);
    });
  }
});

describe('難易度の定義', () => {
  test('知らないキーはむずかしい（これまでの CPU）になる', () => {
    assert.equal(cpuFor('bogus'), CPU);
    assert.equal(cpuFor(undefined), CPU);
  });

  test('4 段階（rookie・easy・normal・hard の順）で、表示名・説明と ★1〜4 がある', () => {
    assert.deepEqual(Object.keys(LEVELS), ['rookie', 'easy', 'normal', 'hard']);
    assert.deepEqual(Object.keys(LEVEL_INFO), Object.keys(LEVELS));
    Object.keys(LEVELS).forEach((k, i) => {
      assert.ok(LEVEL_INFO[k] && LEVEL_INFO[k].name && LEVEL_INFO[k].desc, k);
      assert.equal(LEVEL_INFO[k].stars, i + 1, k);
    });
    assert.equal(DEFAULT_LEVEL, 'rookie');
  });

  test('設定の罠がない（候補数が全部 0 にならない・反撃を全く読まない設定でない）', () => {
    for (const [k, c] of Object.entries(LEVELS)) {
      if (c.planner === 'rookie') continue; // ROOKIE は読みの設定を使わない（下の ROOKIE のテスト）
      assert.ok(c.topK + c.topSafe + c.topGain > 0, `${k}: 候補が空になる`);
      assert.ok(c.replyNodeCap > 0, `${k}: 反撃を読まない`);
      if (c.oppApQuantile !== undefined) assert.ok(c.oppApQuantile >= 0.5, `${k}: 中央値より下の出目でリーダーを取られる`);
    }
  });
});

describe('EASY・NORMAL（と ROOKIE）の安全柵', () => {
  test('AP 1〜10 で、どの難易度も合法な行動列を返す', () => {
    const bases = [R.createGame(cfg), ...GOLDEN.cases.slice(0, 6).map((c) => unpack(c.state))];
    for (const level of Object.keys(LEVELS)) {
      for (const base of bases) {
        for (const ap of [1, 3, 5, 6, 8, 10]) {
          const s = R.cloneState(base);
          s.phase = 'act';
          s.ap = ap;
          s.apGained = ap;
          const p = planLevel(s, { level, rng: makeRng(ap) });
          let t = s;
          for (const a of p.actions) {
            assert.equal(R.validateAction(t, a), null, `${level} ap ${ap}: ${JSON.stringify(a)}`);
            t = R.applyAction(t, a).state;
          }
        }
      }
    }
  });

  test('そのターンに勝てるなら、EASY・NORMAL・HARD は必ず勝つ（ROOKIE は連携を読まないので対象外。下の ROOKIE のテスト）', () => {
    // 戦士で削ってから弓でとどめを刺す 8AP の連携（先に弓だと押し出しで届かない）
    const s = board({ 0: '.........l', 2: '.....w....', 8: '..a..L....' }, { side: MONSTER, ap: 8, hp: { L: 2 } });
    for (const level of Object.keys(LEVELS).filter((k) => LEVELS[k].planner !== 'rookie')) {
      for (let seed = 1; seed <= 5; seed++) {
        let t = s;
        for (const a of planLevel(s, { level, rng: makeRng(seed) }).actions) t = R.applyAction(t, a).state;
        assert.equal(t.winner, MONSTER, `${level} seed ${seed}`);
      }
    }
  });

  test('相手の AP を中央値で頭打ちにした分布（確率の合計 1、上限は ▲0・▲1 で 4、▲2・▲3 で 5）', () => {
    const caps = [4, 4, 5, 5];
    for (let st = 0; st < 4; st++) {
      const c = cappedDist(apDistribution(st), 0.5);
      assert.equal(c.max, caps[st], `stage ${st}`);
      assert.ok(Math.abs(c.dist.reduce((a, [, p]) => a + p, 0) - 1) < 1e-9);
      assert.equal(c.dist[c.dist.length - 1][0], caps[st]);
    }
  });

  test('pickSafe: 最善手がリーダーを失わないなら、失う候補は選ばない', () => {
    const s = R.createGame(cfg);
    s.phase = 'act';
    const node = (sc, worst) => ({ sc, worst, s });
    const best = node(10, 0);
    const lose = node(9.9, -WIN_SCORE); // ほぼ同点だが、想定内の AP でリーダーを失う
    const ok = node(9, 0);
    const cpu = { pickTemp: 2, pickMaxDrop: 4, pickSafe: true };
    for (let seed = 1; seed <= 200; seed++) assert.notEqual(pickNearBest([best, lose, ok], best, 10, s, cpu, makeRng(seed)), lose);
  });

  test('往復防止: 駒を前のターンの位置へ戻す候補は、最善手でなければ選ばない', () => {
    const s = R.createGame(cfg);
    s.phase = 'act';
    s.side = HUMAN;
    const u = cfg.sideUnits[HUMAN][1]; // 戦士1
    const prevStart = Array.from(s.pos);
    prevStart[u] = s.pos[u] - 10; // 前のターンは 1 マス上にいた
    const moved = (cell) => {
      const t = R.cloneState(s);
      t.pos[u] = cell;
      return t;
    };
    const best = { sc: 10, worst: 0, s: moved(s.pos[u] + 1) };
    const back = { sc: 9.9, worst: 0, s: moved(prevStart[u]) }; // 前の位置へ戻る
    const cpu = { pickTemp: 2, pickMaxDrop: 4 };
    for (let seed = 1; seed <= 200; seed++) assert.notEqual(pickNearBest([best, back], best, 10, s, cpu, makeRng(seed), prevStart), back);
    // 戻る手が最善なら選んでよい
    assert.equal(pickNearBest([back], back, 9.9, s, cpu, makeRng(1), prevStart), back);
  });

  test('pickMaxDrop: 最善から離れすぎた候補は選ばない', () => {
    const s = R.createGame(cfg);
    s.phase = 'act';
    const best = { sc: 10, worst: 0, s };
    const far = { sc: 5, worst: 0, s };
    for (let seed = 1; seed <= 100; seed++) assert.equal(pickNearBest([best, far], best, 10, s, { pickTemp: 50, pickMaxDrop: 4 }, makeRng(seed)), best);
  });
});

// ---------------------------------------------------------------------------
// やさしい（EASY）の性格（1 局に 1 つの思い違い）
// ---------------------------------------------------------------------------

/** EASY（性格つき）で、そのターンに勝てるか（乱数を変えて seeds 回） */
const winsWith = (s, persona, seeds = 5) => {
  for (let seed = 1; seed <= seeds; seed++) {
    let t = s;
    for (const a of planLevel(s, { level: 'easy', rng: makeRng(seed), persona }).actions) t = R.applyAction(t, a).state;
    if (t.winner !== MONSTER) return false;
  }
  return true;
};

describe('やさしい（EASY）の性格', () => {
  test('性格を持つのは EASY だけ。EASY は毎回どれかの性格になる', () => {
    assert.equal(pickPersona('hard'), null);
    assert.equal(pickPersona('normal'), null);
    assert.equal(pickPersona('rookie'), null);
    for (let i = 1; i <= 50; i++) assert.ok(PERSONAS[pickPersona('easy', makeRng(i))]);
    for (const k of Object.keys(LEVELS.easy.personas)) assert.ok(PERSONAS[k].name && PERSONAS[k].hint, k);
  });

  test('AP 1〜10 で、どの性格も実ルールで合法な行動列を返す', () => {
    const bases = [R.createGame(cfg), ...GOLDEN.cases.slice(0, 6).map((c) => unpack(c.state))];
    for (const persona of Object.keys(PERSONAS)) {
      for (const base of bases) {
        for (const ap of [1, 3, 5, 6, 8, 10]) {
          const s = R.cloneState(base);
          s.phase = 'act';
          s.ap = ap;
          s.apGained = ap;
          let t = s;
          for (const a of planLevel(s, { level: 'easy', rng: makeRng(ap), persona }).actions) {
            assert.equal(R.validateAction(t, a), null, `${persona} ap ${ap}: ${JSON.stringify(a)}`);
            t = R.applyAction(t, a).state;
          }
        }
      }
    }
  });

  test('押し出しを忘れていても、そのターンに勝てるなら必ず勝つ', () => {
    // 戦士で削ってから弓でとどめを刺す 8AP の連携（先に弓だと押し出しで届かない）
    const s = board({ 0: '.........l', 2: '.....w....', 8: '..a..L....' }, { side: MONSTER, ap: 8, hp: { L: 2 } });
    for (const persona of Object.keys(PERSONAS)) assert.ok(winsWith(s, persona), persona);
  });

  test('弓の 4 マス目・岩越しの魔法でしか届かない勝ちも取る（思い違いより実ルールを優先）', () => {
    const archer = board({ 0: 'a...L.....', 9: '.........l' }, { side: MONSTER, ap: 2, hp: { L: 1 } });
    const mage = board({ 0: 'm#L.......', 9: '.........l' }, { side: MONSTER, ap: 2, hp: { L: 1 } });
    for (const persona of Object.keys(PERSONAS)) {
      assert.ok(winsWith(archer, persona), `${persona} 弓`);
      assert.ok(winsWith(mage, persona), `${persona} 魔法`);
    }
  });

  test('性格を渡さなければ、EASY は性格なしで指す（UI の配線漏れでも落ちない）', () => {
    const s = R.createGame(cfg);
    s.phase = 'act';
    s.ap = 5;
    s.apGained = 5;
    assert.ok(Array.isArray(planLevel(s, { level: 'easy', rng: makeRng(1) }).actions));
  });
});

// ---------------------------------------------------------------------------
// ROOKIE（ターン全体の手順を読まず、1 体ずつよさそうな行動を選ぶ）
// ---------------------------------------------------------------------------

/** 計画を実ルールで 1 手ずつ確かめながら適用する */
function applyChecked(s, actions, label) {
  let t = s;
  for (const a of actions) {
    assert.equal(R.validateAction(t, a), null, `${label}: ${JSON.stringify(a)}`);
    t = R.applyAction(t, a).state;
  }
  return t;
}
const rookie = (s, seed = 1, prevStart) => planLevel(s, { level: 'rookie', rng: makeRng(seed), prevStart });

describe('ROOKIE', () => {
  test('ROOKIE の設定（読みの設定ではなく、ROOKIE 用の項目を持つ）', () => {
    const c = LEVELS.rookie;
    assert.equal(c.planner, 'rookie');
    assert.ok(c.vision >= 1 && c.vision <= 4, '移動して攻撃を考える距離');
    assert.ok(c.minGain >= 0 && c.noise >= 0 && c.backtrack > 0);
    assert.ok(c.leaderDanger > 0 && c.wDanger > 0, 'リーダーや駒の危険を全く考えない設定でない');
  });

  test('AP 1〜10・ダイス強化（▲0〜▲3）のどれでも、合法な行動列を返す', () => {
    const bases = [R.createGame(cfg), R.createGame(cfg, { firstSide: MONSTER }), ...GOLDEN.cases.map((c) => unpack(c.state))];
    for (const [bi, base] of bases.entries()) {
      for (let ap = 1; ap <= 10; ap++) {
        const s = R.cloneState(base);
        s.phase = 'act';
        s.ap = ap;
        s.apGained = ap;
        s.lost = [(bi + ap) % 4, (bi + ap + 1) % 4];
        applyChecked(s, rookie(s, ap).actions, `base ${bi} ap ${ap}`);
      }
    }
  });

  test('目の前の勝ちは取る（隣の HP1 リーダー・弓の射程内・寄って殴る・近くの 2 体で）', () => {
    const cases = {
      隣: board({ 0: '.........l', 5: '....wL....' }, { side: MONSTER, ap: 1, hp: { L: 1 } }),
      // 弓の 4 マス目（ROOKIE も自分の攻撃は実ルールで考える）
      弓: board({ 0: 'L.........', 4: 'a.........', 9: '.........l' }, { side: MONSTER, ap: 2, hp: { L: 1 } }),
      寄る: board({ 0: '.........l', 5: '..w.......', 7: '..L.......' }, { side: MONSTER, ap: 2, hp: { L: 1 } }),
      // HP2 のリーダーを、隣にいる 2 体で（見えやすい連携）
      二体: board({ 0: '.........l', 5: '....w.....', 6: '....L.....', 7: '....w.....' }, { side: MONSTER, ap: 2, hp: { L: 2 } }),
    };
    for (const [name, s] of Object.entries(cases)) {
      for (let seed = 1; seed <= 5; seed++) assert.equal(applyChecked(s, rookie(s, seed).actions, name).winner, MONSTER, `${name} seed ${seed}`);
    }
  });

  test('射程内の敵や弱った敵を見逃さない（攻撃できるときは攻撃する）', () => {
    // 戦士の隣に HP1 の敵戦士、弓の射程に HP1 の敵の魔法使い。どちらも倒せる
    const s = board({ 0: '.........l', 5: '....wW....', 8: '....a.....', 9: '....M....L' }, { side: MONSTER, ap: 4, hp: { W: 1, M: 1 } });
    for (let seed = 1; seed <= 5; seed++) {
      const t = applyChecked(s, rookie(s, seed).actions, `seed ${seed}`);
      assert.equal(t.lost[HUMAN], 2, `seed ${seed}: 2 体とも倒す`);
    }
  });

  test('リーダーを無防備に差し出さない（敵の戦士 2 体に挟まれた HP1 のリーダーは逃げる）', () => {
    const s = board({ 1: '...WlW....', 9: '.........L' }, { side: MONSTER, ap: 3, hp: { l: 1 } });
    for (let seed = 1; seed <= 5; seed++) {
      const t = applyChecked(s, rookie(s, seed).actions, `seed ${seed}`);
      const lp = t.pos[t.cfg.leaderOf[MONSTER]];
      const adj = t.cfg.neighbors[lp].filter((c) => R.unitAt(t, c) >= 0 && t.cfg.unitSide[R.unitAt(t, c)] === HUMAN);
      assert.equal(adj.length, 0, `seed ${seed}: リーダーが敵の隣に残っている`);
    }
  });

  test('同じ局面・同じ乱数なら同じ手（Worker へ送る形に複製した局面でも同じ）', () => {
    const s = unpack(GOLDEN.cases[5].state, 6);
    const a = rookie(s, 3).actions;
    assert.deepEqual(rookie(s, 3).actions, a);
    assert.deepEqual(planLevel(structuredClone(s), { level: 'rookie', rng: makeRng(3) }).actions, a);
  });

  test('対局が最後まで進む（ROOKIE 対 ROOKIE・ROOKIE 対 EASY）。往復は少なく、1 手は速い', () => {
    let turns = 0;
    let ms = 0;
    let backs = 0;
    for (const [seed, opp] of [
      [11, 'rookie'],
      [12, 'easy'],
      [13, 'rookie'],
    ]) {
      const dice = makeRng(seed);
      let s = R.createGame(cfg, { firstSide: seed % 2 ? HUMAN : MONSTER });
      const levels = ['rookie', opp];
      const persona = pickPersona(opp, makeRng(seed));
      const prev = [null, null];
      let t = 0;
      while (s.phase !== 'over') {
        s = R.beginTurn(s, R.rollDiceFor(s, dice));
        const side = s.side;
        const p = planLevel(s, { level: levels[side], rng: makeRng(seed * 1000 + t), prevStart: prev[side], persona: side ? persona : null });
        if (side === HUMAN) {
          turns++;
          ms += p.info.ms;
          for (const a of p.actions) if (a.type === 'move' && prev[side] && prev[side][a.unit] === a.to && s.pos[a.unit] !== a.to) backs++;
        }
        prev[side] = Array.from(s.pos);
        s = applyChecked(s, p.actions, `${seed} turn ${t}`);
        if (s.phase !== 'over') s = R.endTurn(s);
        t++;
        assert.ok(t <= 80, '40 ラウンドで終わる');
      }
      assert.ok(s.winner === HUMAN || s.winner === MONSTER || s.winner === 'draw');
    }
    assert.ok(backs <= turns * 0.05, `往復 ${backs} 回 / ${turns} ターン`);
    assert.ok(ms / turns < 100, `平均 ${(ms / turns).toFixed(1)}ms / ターン`);
  });
});
