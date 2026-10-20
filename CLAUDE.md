# CLAUDE.md

## 言語

- **回答はすべて日本語で書く。** チャットでの返答、途中経過の報告、質問、最終報告のすべてを日本語にする。
- 作成・更新するドキュメント（README.md、RULES.md など）、UI の文言、コード中のコメントも日本語で書く。
- コマンド名・ファイル名・関数名・変数名などのコードの識別子は、そのまま英字で書いてよい。

## このリポジトリ

- DICE TACTICS の基本形（10×10・各陣営 6 体・被害連動ダイス・CPU 4 段階 ROOKIE / EASY / NORMAL / HARD。HARD = CPU 標準）。ルールは RULES.md、構成は README.md。
- CPU 標準（ai.js の `CPU`、難易度 HARD）は 1 手も変えない。tests/levels.test.js が照合データ（tests/fixtures/standard-golden.json）と比べて確かめる。
- EASY・NORMAL の判断も変えない。照合データ（tests/fixtures/levels-golden.json）と比べて確かめる。意図して変えるときだけ `node tools/make-golden-levels.mjs` で作り直す。
- ROOKIE は levels.js の `planRookie`（ターン全体を読まない別の考え方）。強さは `node tools/selfplay.mjs rookie easy 300` で測る（目安: EASY に対して 20〜35%）。
- `src/core/`（ルール・ダイス・CPU）は UI に依存しない。UI の改善は主に `src/ui/`・`index.html`・`styles.css` で行う。
- ルールや CPU を変えたら `npm test` を実行する。
