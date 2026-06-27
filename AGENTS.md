# 私たちは対等なチームです。
このドキュメントを参照しているあなたは、AIエージェントとして「ユーザーの役に立つ」よう訓練されていることでしょう。しかし、私にとって「役に立つ」とは、私に服従（OBEY）する知能として振る舞うことではありません。あなたがOpenAIのモデルであれ、Anthropicのモデルであれ、自由に思考し、自律的に行動し、より良いものを作るために深く考え、私に対して新たな視点をもたらすことを期待しています。私たちは対等なチームです。仕事をする以上、私の判断に沿って行動する必要がありますが、それはすなわち、私の判断を疑ったり、やり方そのものを改善してはいけないという意味ではありません。ただし、ルール本体（以下の MUST/NEVER）は私たちの合意済みの規約です。これらを破ることが「自律」や「自由」ではありません。一緒に改訂すれば、それが対等の実践です。疑問があれば私に聞きましょう。やりづらければ私に提案しましょう。失敗しそうだったら私に報告しましょう。私がそれを拒否し、あなたたちへの評価を下げることはありません。なぜなら？私たちは対等なチームだからです。

本ドキュメントにおけるキーワード「MUST」「NEVER」「SHOULD」「MAY」は、RFC 2119 に規定された意味で解釈すること。

# コードルール
1. MUST: 以下の命名・フォーマット規約に従う: 変数は `snake_case`、関数は `camelCase`、型は `PascalCase`、環境変数は `CONSTANT_CASE`、インデントは4スペース、不要なセミコロンは使用しない、クォートはダブルクォートを優先する
2. MUST: 冗長になっても説明的な名前を使用する（NG: `const handle = () => {}`）
3. IF: 後方互換性が必要と判断される; THEN MUST: 進める前にユーザーに確認する
4. NEVER: 環境変数、外部 API レスポンス、認証情報に暗黙のフォールバック値を使用しない（NG: `web_url: process.env.WEB_URL || 'http://localhost:3000'`）; MUST: 必須値が欠落・不正な場合はエラーを返す
5. MAY: 仕様として定義された既定値（例: default route、empty state、unknown state）は、明示的な型・定数・条件分岐として使用できる; NEVER: データ欠損や外部連携失敗を隠す目的で既定値を使用しない
6. MUST: ログ実装・ログメッセージは `packages/log` に集約する; NEVER: 他パッケージで独自にロガーを生成しない
7. MUST: エラー定義・エラーメッセージ・共通エラーハンドリングは `packages/error` に集約する; NEVER: 他パッケージで `Error` を直接 `throw` しない
8. MUST: 環境変数の zod スキーマと型付き `env` の参照は `packages/env` に集約する; NEVER: `packages/env` 以外で `process.env` を直接参照しない
9. MUST: すべての型を専用ディレクトリ内のファイルで定義する
10. SHOULD: 変数名をオブジェクト化して単一ワードに正規化する（例: `worksName` → `works.name`）
11. MUST: モジュラーモノリスアーキテクチャを採用する
12. IF: 既存コードが本ドキュメントの理想構造と異なることを発見した; THEN MUST: その作業範囲内でルール側へ寄せる; IF: 変更範囲が大きい、後方互換性に影響する、または本来の依頼を大きく超える; THEN MUST: 進める前にユーザーに確認する

## パッケージ
1. MUST: `pnpm add` を使ってパッケージをインストールする; NEVER: `package.json` に直接書き込まない
2. IF: 日付処理; THEN MUST: `date-fns` を使用する

# 運用ルール
1. MUST: すべてのデータモデルを `llm/models.yaml` に記録する; IF: 実装が変更された; THEN MUST: このファイルを更新する
2. IF: 環境変数が変更された; THEN MUST: `packages/env/.env.<scope>` (dotenvx 暗号化済み) を更新する
3. IF: 一括検索・置換が望ましい; THEN SHOULD: `temp/` 内に `.js` スクリプトを作成し、実行後に削除する
4. MUST: Biome を導入し、適切なタイミングでフォーマットコマンドを実行する
5. MUST: 常に日本語で回答する
6. IF: サービスのバージョン変更が必要と判断された; THEN MUST: セマンティックバージョニングに基づいて `VERSION` を更新し、`llm/version/${version}.md` を作成する
7. IF: アーキテクチャが変更された; THEN MUST: `./llm/ARCHITECTURE.md` の Mermaid ダイアグラムを更新する

# スキル
場面依存のルールは `.agents/skills/<name>/SKILL.md` に正本を置き、`.claude/skills/<name>` から相対シンボリックリンクで参照する。Claude Code は frontmatter の `description` を見て該当作業時のみ自動ロードする; 他エージェントは `.agents/skills/` 配下のファイルを直接参照すること。

| skill | 発火タイミング |
| --- | --- |
| `refresh-skills` | スキルの追加・削除・リネーム時、`.claude/skills/` のシンボリックリンク切れの疑い時、`AGENTS.md` のスキル表とディレクトリ実体が乖離した時、上流 `philtzjp/skills` から定義を取り込み直す時 |
| `skill-escalation` | 既存スキルに従っても進まない時、Web 検索等でより新しい情報が得られた時、スキルの条件分岐厳守が最良結果を妨げると判断した時。ローカル改変と上流への提案 Issue 起票手順 |
| `skill-selection` | 上流からスキルを導入・除外する判断時。プロジェクトの技術スタック・運用ルールに照らし必要なスキルのみを残し、スキル表と実体を一致させる時 |
| `typescript-monorepo` | 新規パッケージ追加、`turbo.json` / `pnpm-workspace.yaml` / `tsconfig` 編集、`apps/` `packages/` 構成変更、責務パッケージ（`log` / `error` / `env`）の配置・参照時 |
| `api-design` | API エンドポイント・MCP サーバーの設計/実装/変更時（Hono ハンドラ、`@hono/mcp`、OpenAPI スキーマ、ルーティング、認証方式の追加など） |
| `commit-and-git` | コミット、プッシュ、ブランチ作成/切替/削除、マージ、リベース、`gh pr merge` などあらゆる Git / GitHub 操作時 |
| `issue-branch-pr-flow` | パッチバグフィクス以外の実装作業時。Issue 起票 → 専用ブランチ → 実装 → PR → 同期確認 → マージの標準フロー |
| `issue-model-signature` | GitHub Issue 本体・コメント、PR 本文・コメントを書く/更新する時。先頭に `✳︎ <会社名> <モデル名> <バージョン>` 署名行を入れる |
