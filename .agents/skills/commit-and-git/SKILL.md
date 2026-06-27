---
name: commit-and-git
description: "コミット、プッシュ、ブランチ作成/切り替え/削除、マージ、リベース、`gh pr merge` による PR マージなどあらゆる Git / GitHub 操作を行うときに参照する。コミットメッセージのフォーマット (`type(scope): 説明`)、マージコミット件名 (`merge(scope): 説明`) の `--subject` / `--body \"\"` 指定、`--author` の扱い、`git fetch --prune` などの安全チェック、マージコミット件名・本文への PR/Issue 番号 (`#N`) 禁止、`Co-Authored-By` 禁止、`git add .` 禁止などを定義する。"
---

# コミットメッセージ
1. MUST: `type: 説明（日本語、短い文）` のフォーマットを使用する
2. IF: モノレポ; THEN MUST: `type(scope): 説明（日本語、短い文）` のフォーマットを使用し、説明を短く保つためにカッコ表記は用いない。
3. MUST: `scope` にはファイル変更のあったトップレベルディレクトリ名（リポジトリ直下のディレクトリ名）を使用する; IF: Turborepo などのモノレポで `apps/` や `packages/` 配下を変更する; THEN MUST: 配下のパッケージ／アプリ名（leaf 名）を使用する（例: `apps/dashboard` の変更なら `dashboard`、`packages/log` の変更なら `log`）; MUST: リポジトリ全体に関わる変更は `repo` を使用する; MUST: 隠しディレクトリは先頭ドットを含めて書く（`agents` ではなく `.agents`）
4. NEVER: `scope` にスラッシュを含めて階層を表現しない; NEVER: `apps` / `packages` などモノレポの親ディレクトリ自体を `scope` に使用しない; NEVER: `workspace` / `design` など実体のない総称、存在しないフォルダ名を `scope` に使用しない（NG: `feat(workspace): ...` / `feat(design): ...` / `feat(agents): ...` / `feat(apps): ...` / `feat(packages): ...` / `feat(apps/dashboard): ...` / `feat(packages/log): ...` → OK: `feat(repo): ...` / `feat(.agents): ...` / `feat(.claude): ...` / `feat(dashboard): ...` / `feat(log): ...`）
5. MUST: 説明は動作で終える（OK: `〜する` / `〜追加` / `〜修正` / `〜削除` / `〜実装` など）; NEVER: 動作を伴わない名詞で終える（NG: `feat(api): ユーザー認証` → OK: `feat(api): ユーザー認証を追加`）; NEVER: 説明に emoji を含めない
6. MUST: 論理的なスコープ（パッケージ、機能）ごとにコミットを分割する; NEVER: 無関係な変更をまとめてコミットしない
7. 変更をコミットする際:
   - ファイルごとに `git diff` を実行して各変更の作者を確認する。
   - NEVER: committer を上書きしない（常にユーザーの git config を使用する）
   - IF: すべての変更がエージェントによって生成された（ユーザー編集行がない）; THEN MUST: `--author` のみで自身のエージェント種別を明示する:
      - OpenAI (Codex): `git commit --author="Codex <noreply@openai.com>" -m "<message>"`
      - Anthropic (Claude): `git commit --author="Claude <noreply@anthropic.com>" -m "<message>"`
   - IF: 一部でもユーザーによる変更がある; THEN MUST: 通常の `git commit` を使用する。
8. NEVER: `Co-Authored-By` を追加しない
9. NEVER: `git add .` や `git add -A` を使用しない
10. NEVER: 無関係な変更を1つのコミットに混在させない

## コミットメッセージのプレフィクス
`feat`=新機能, `fix`=バグ修正, `perf`=性能改善, `refactor`=機能変更なしの改善, `docs`=ドキュメント, `style`=スタイル修正, `test`=テスト, `chore`=その他, `ci`=CI/CD設定, `build`=ビルド設定, `merge`=PR のマージ（マージコミット専用）

# Git 操作
1. MUST: あらゆる Git 操作（コミット、プッシュ、ブランチ作成、マージ、リベース）の前に `git fetch --prune` を実行する
2. MUST: 現在のブランチがデフォルトブランチにマージ済みか確認する; IF: マージ済み; THEN: ユーザーに警告してブランチの切り替えを提案する
3. MUST: リモートトラッキングブランチがまだ存在するか確認する; IF: 削除されている; THEN: ユーザーに警告する
4. MUST: ローカルブランチがリモートより遅れていないか確認する; IF: 遅れている; THEN: `git pull --rebase` を提案する
5. IF: ローカルブランチがリモートと乖離している; THEN SHOULD: ユーザーに警告し、リベースまたはマージを提案する
6. MUST: GitHub CLI で PR を作成する場合は `gh pr create --body "<本文>"` または `gh pr create --body-file <file>` を使用し、PR 本文を明示する
7. NEVER: コミットメッセージ、PR 本文、マージコミットメッセージに `Co-Authored-By` を含めない
8. MUST: PR のマージ方式は merge commit を使用する
9. MUST: PR をマージする場合は `gh pr merge <番号> --merge --subject "merge(scope): 説明（日本語、短い文）" --body ""` で件名と空の本文を明示する; NEVER: デフォルトのマージコミットメッセージ（`Merge pull request #N from ...`）を使用しない; NEVER: 件名・本文に PR 番号（`#N`）や Issue 番号など参照を含めない; NEVER: `merge` プレフィクスでマージであることが明示されるため、説明文に「マージ」と書かない（NG: `merge(api): foo をマージ` → OK: `merge(api): foo を追加`）
10. NEVER: squash merge / squash commit を使用しない。ただしユーザーが明示的に指示した場合のみ例外とする
11. NEVER: ユーザーの確認なしにブランチを切り替えない
12. NEVER: ユーザーの承認なしに `git pull` や `git rebase` を実行しない
13. NEVER: ユーザーの確認なしにローカルブランチを削除しない
