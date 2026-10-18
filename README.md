# DICE TACTICS 基本形

ダイス × ターン制の戦術ボードゲーム。このフォルダは、検証用プロトタイプ（Prototype 01〜03）から切り出した **基本形** で、UI の改善を進めるための出発点。

- 盤面: 10×10、各陣営 6 体（リーダー・戦士×2・弓使い×2・魔法使い）
- AP: **被害連動ダイス**（基本 1 ＋ ダイス 3 個。リーダー以外の味方を失うほどダイスが強化され、1〜7AP → 最大 1〜10AP）
- 対戦相手: CPU（標準）
- ルールの詳細: [RULES.md](RULES.md)

## 起動

必要なもの: Node.js 18 以上。外部パッケージは不要（`npm install` も不要）。

- **Windows**: `launch.bat` をダブルクリック。黒いウィンドウでサーバーが起動し、既定のブラウザでゲームが開く。終了するときはそのウィンドウを閉じる。ポート 8130 が使用中なら次の空いているポートを使う。
- **その他**: `npm start`（または `node serve.js`）で起動し、表示されたアドレス（既定 http://localhost:8130/）を開く。

ES Modules と Web Worker を使うため、`index.html` を直接開く（file://）と動かない。必ずサーバー経由で開く。

## 遊び方

1. 「ダイスを振る」（Space）で、このターンの AP が決まる。
2. 自分のユニットをクリックして選ぶ。水色のマス = 移動先（数字は消費 AP）、赤い枠の敵 = 攻撃できる相手。
3. マスをクリックで移動、敵をクリックで攻撃。AP の範囲で好きな順番に行動する。攻撃するまでの移動は「移動を戻す」（Z）で取り消せる。
4. 「ターン終了」（E）。CPU が 1 手ずつ行動する。
5. 味方が倒されると、ダイスの強化が通知される（例「戦士1が倒された！ ダイス強化 ▲1：2・2・2 → 3・2・2」）。両陣営の強化段階はダイスの下に表示。

キー: Space / Enter = ダイスを振る、E = ターン終了、Z = 移動を戻す、1〜6 = 自ユニットを選択（王・戦1・戦2・弓1・弓2・魔）、Esc = 選択解除。先手は画面右上で選んでから「新しいゲーム」。

## 構成

```
index.html              画面の骨組み
styles.css              見た目
launch.bat / serve.js   起動（依存なしの静的ファイルサーバー）
src/core/               ゲームの中身（UI に依存しない。Node.js でもブラウザでも動く）
  config.js             盤面・ユニット・ルールの定数、初期配置
  dice.js               被害連動ダイス（段階・正確な確率分布・ダイスを振る）
  rules.js              ルールエンジン（合法判定・移動・攻撃・押し出し・勝敗・ターン）
  ai.js                 CPU（標準）
  rng.js                シード付き乱数
src/ui/                 画面（ここを作り直す想定）
  app.js                ゲームの進行と入力（ダイス → 行動 → ターン終了 → CPU の手番）
  view.js               描画（game の状態から DOM を作るだけ）
  cpu.js                CPU の呼び出し（Web Worker。使えなければメインスレッド）
  cpu-worker.js         CPU 思考用の Web Worker
tests/                  自動テスト（npm test）
```

### UI を作り直すときに使うコアの API

UI から使うのは主に次の関数。状態はイミュータブルで、各関数は新しい状態を返す。

| 関数 | 用途 |
|---|---|
| `makeConfig()`（config.js） | 盤面・ユニット構成の設定 `cfg` |
| `createGame(cfg, { firstSide })` | 新しいゲーム（`phase: 'roll'`） |
| `rollDiceFor(state, rng)` → `beginTurn(state, dice)` | ダイスを振ってターン開始（`phase: 'act'`、`state.ap` が決まる） |
| `moveOptions(state, unit)` | 移動先の一覧 `[{cell, cost, path}]` |
| `attackOptions(state, unit)` | 攻撃できる敵の一覧 `[{target, dir, overObstacle, cost, hit}]`（`hit` = 撃破・押し出し先の予測） |
| `validateAction(state, action)` | 行動が違法なら理由の文字列（合法なら null） |
| `applyAction(state, action)` | 行動を適用。`{ state, events }` を返す。events（move の経路・attack・damage・kill・knockback など）を演出に使える |
| `endTurn(state)` | ターン終了（相手の `phase: 'roll'` へ。40 ラウンドで引き分け） |
| `diceMaxOf(state, side)` / `diceStageOf(state, side)` | 各陣営のダイスの最大値・強化段階 |
| `planTurn(state)`（ai.js、UI からは cpu.js の `requestPlan`） | CPU の行動列 `{ actions, info }`。actions を順に `applyAction` すればよい |

行動は `{ type: 'move', unit, to }`・`{ type: 'attack', unit, target }`。ユニット番号は 0〜5 が人間族（王・戦1・戦2・弓1・弓2・魔）、6〜11 がモンスター族。マス番号は `y * 10 + x`（y = 0 が上端）。

デバッグ用に、ブラウザのコンソールから `window.__dt`（ゲームの状態と操作関数）を参照できる。

## テスト

```bash
npm test
```

23 件（ルール・被害連動ダイス・CPU）。Node.js 標準の `node:test` を使う。

## 切り出し元との関係

- 切り出し元: DICE TACTICS Prototype 01〜03（Classic 7×7・Expanded 10×10、旧ダイス・固定 AP、CPU 3 種、シミュレーション・分析ツール）。この基本形には、そのうち「Expanded・被害連動ダイス・CPU 標準」だけを残した。
- ルールと CPU は切り出し元と同じ。切り出し元の `tools/basic-equivalence.js` で、同じシードの対局を両方の実装で並べて動かし、出目・CPU の行動・局面が 20 試合（817 ターン）すべて一致することを確認した。
- UI は作り直した（必要最低限: 盤面・ユニットと HP・移動先と攻撃対象の表示・ダイスと AP・両陣営の強化段階と強化の通知・行動履歴・結果画面・先手の選択・移動の取り消し）。切り出し元にあった演出（移動のアニメーション・押し出しの矢印・CPU の狙いの表示・敵の攻撃範囲の表示など）は含めていない。
- CPU の設計・シミュレーション結果・未確認事項は、切り出し元の CPU_DESIGN.md・DICE_EVOLUTION_REPORT.md を参照。
