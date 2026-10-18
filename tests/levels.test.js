// 難易度のテスト
//   むずかしい = これまでの CPU（標準）が 1 手も変わっていないこと（照合データ tests/fixtures/standard-golden.json）
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeConfig, HUMAN, MONSTER } from '../src/core/config.js';
import * as R from '../src/core/rules.js';
import { planTurn, CPU, cappedDist, pickNearBest, WIN_SCORE } from '../src/core/ai.js';
import { apDistribution } from '../src/core/dice.js';
import { LEVELS, LEVEL_INFO, PERSONAS, cpuFor, pickPersona, planLevel } from '../src/core/levels.js';
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

describe('難易度の定義', () => {
  test('知らないキーはむずかしい（これまでの CPU）になる', () => {
    assert.equal(cpuFor('bogus'), CPU);
    assert.equal(cpuFor(undefined), CPU);
  });

  test('すべての難易度に表示名と説明がある', () => {
    for (const k of Object.keys(LEVELS)) {
      assert.ok(LEVEL_INFO[k] && LEVEL_INFO[k].name && LEVEL_INFO[k].desc, k);
      assert.ok(LEVEL_INFO[k].stars >= 1 && LEVEL_INFO[k].stars <= 3, k);
    }
  });

  test('設定の罠がない（候補数が全部 0 にならない・反撃を全く読まない設定でない）', () => {
    for (const [k, c] of Object.entries(LEVELS)) {
      assert.ok(c.topK + c.topSafe + c.topGain > 0, `${k}: 候補が空になる`);
      assert.ok(c.replyNodeCap > 0, `${k}: 反撃を読まない`);
      if (c.oppApQuantile !== undefined) assert.ok(c.oppApQuantile >= 0.5, `${k}: 中央値より下の出目でリーダーを取られる`);
    }
  });
});

describe('やさしい・ふつうの安全柵', () => {
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

  test('そのターンに勝てるなら、どの難易度も必ず勝つ', () => {
    // 戦士で削ってから弓でとどめを刺す 8AP の連携（先に弓だと押し出しで届かない）
    const s = board({ 0: '.........l', 2: '.....w....', 8: '..a..L....' }, { side: MONSTER, ap: 8, hp: { L: 2 } });
    for (const level of Object.keys(LEVELS)) {
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
// やさしいの性格（1 局に 1 つの思い違い）
// ---------------------------------------------------------------------------

/** やさしい（性格つき）で、そのターンに勝てるか（乱数を変えて seeds 回） */
const winsWith = (s, persona, seeds = 5) => {
  for (let seed = 1; seed <= seeds; seed++) {
    let t = s;
    for (const a of planLevel(s, { level: 'easy', rng: makeRng(seed), persona }).actions) t = R.applyAction(t, a).state;
    if (t.winner !== MONSTER) return false;
  }
  return true;
};

describe('やさしいの性格', () => {
  test('性格を持つのはやさしいだけ。やさしいは毎回どれかの性格になる', () => {
    assert.equal(pickPersona('hard'), null);
    assert.equal(pickPersona('normal'), null);
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

  test('性格を渡さなければ、やさしいは性格なしで指す（UI の配線漏れでも落ちない）', () => {
    const s = R.createGame(cfg);
    s.phase = 'act';
    s.ap = 5;
    s.apGained = 5;
    assert.ok(Array.isArray(planLevel(s, { level: 'easy', rng: makeRng(1) }).actions));
  });
});
