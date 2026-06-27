---
name: skill-escalation
description: 既存スキルに従って作業しても期待通り進まないとき、Web 検索などで異なる情報・より新しい情報が得られたとき、スキルの条件分岐を厳守するとスタックや実装の自由度が制限され最良の結果が得られないと判断したときに参照する。`.agents/skills/<name>/SKILL.md` をローカルで改変する手順、および改変内容が有用と判断した場合に `philtzjp/skills` リポジトリへ変更提案 Issue を起票する手順とテンプレートを定義する。
---

# スキル改良とエスカレーション

## 発火タイミング

1. 既存スキルに従って作業したが期待通り進まなかった
2. Web 検索など外部情報源で、スキル記述と異なる／より新しい情報が得られた
3. スキルの条件分岐を厳守するとスタックや実装の自由度が制限され、最良の結果が得られないと判断した

## ローカル改変

1. MUST: スキル正本 `.agents/skills/<name>/SKILL.md` を直接編集する
2. MUST: 編集内容が `commit-and-git` / `issue-branch-pr-flow` など他スキルと矛盾しないか確認する
3. MUST: 編集後は `refresh-skills` の整合性検査を実行し、`description` の意味（発火条件）が変わる場合は `AGENTS.md` / `CLAUDE.md` のスキル表も更新する
4. NEVER: `.claude/skills/<name>/SKILL.md` の symlink 先以外を編集する（実体は `.agents/skills/<name>/SKILL.md`）

## エスカレーション判断

1. MUST: ローカル改変が他ユーザー／他エージェントにも有用と判断した場合、`philtzjp/skills` リポジトリに変更提案 Issue を起票する
2. SHOULD: 単発のワークアラウンドや、特定タスク固有の例外は Issue 化しない
3. SHOULD: 既存 Issue / PR があれば、新規起票せずそこへコメント追記する

## Issue 起票

1. MUST: `gh issue create --title "<title>" --body-file <file>` で起票する
2. MUST: タイトルは `type(scope): 短い日本語` 形式を使用する
   - `type` は `feat` / `fix` / `perf` / `refactor` のいずれか
   - `scope` は変更対象スキル名（例: `commit-and-git` / `refresh-skills` / `issue-model-signature`）
3. MUST: タイトルの説明は動作で終える（OK: `〜する` / `〜修正` / `〜追加` / `〜削除` / `〜実装` / `〜廃止` など）; NEVER: 体言止めにしない; NEVER: emoji を含めない; MUST: 1 行で完結させる
4. MUST: Issue 本文の先頭は `issue-model-signature` スキルに従い、`✳︎ <会社名> <モデル名> <バージョン>` 形式の署名行を入れ、1 行空けて本文を続ける
5. MUST: 本文には「背景」「作業範囲」「完了条件」「備考」セクションを設ける（後述のテンプレートを使用）

## タイトル例

- `feat(commit-and-git): scope のドット込みディレクトリ表記ルールを明文化する`
- `fix(refresh-skills): symlink 検査スクリプトの誤検知を修正する`
- `refactor(issue-branch-pr-flow): マージ前チェック手順を再編する`
- `perf(api-design): OpenAPI 検証コマンドの実行時間を短縮する`

## 本文テンプレート

`gh issue create --body-file <file>` に渡すファイル（または `--body` の文字列）の中身は以下を使用する。`<...>` を具体内容に置き換える。

```markdown
✳︎ <会社名> <モデル名> <バージョン>

## 背景

なぜこの作業が必要か、動機・関連 Issue/PR を 1〜3 文で書く。

## 作業範囲

- やること 1
- やること 2

## 完了条件

- 受け入れ条件 1
- 受け入れ条件 2

## 備考

補足・参考リンク・注意点（任意）。
```

## GitHub Issue Template ファイル（参考）

GitHub Web UI 経由で人間が起票する場合は、リポジトリルートに `.github/ISSUE_TEMPLATE/skill-escalation.md` を配置する。frontmatter 付き全文は以下:

```markdown
---
name: skill-escalation
about: より良いスキルにするための変更提案をスキルの正本リポジトリに対して起票する
title: "type(scope): 短い日本語"
labels: ""
assignees: ""
---

<!--
タイトル形式: type(scope): 短い日本語

  type は次のいずれか:
    feat / fix / perf / refactor

  scope は変更範囲（スキル名）:

  短い日本語の説明:
    - 体言止めは使用しない（〜する / 〜修正 / 〜追加 / 〜削除 / 〜実装 / 〜廃止 等、動作の意味を持たせる）
    - emoji は使用不可
    - 1 行で完結させる
    - 例: chore(ci): Github Workflow の不整合を修正
    - 例: feat(numsec): plugin と gui を monorepo に移行
    - 例: refactor(xtask): Standalone Target を物理削除
-->

✳︎ ${会社名} ${モデル名} ${バージョン名}

## 背景

なぜこの作業が必要か、動機・関連 Issue/PR を 1〜3 文で書く。

## 作業範囲

- やること 1
- やること 2

## 完了条件

- 受け入れ条件 1
- 受け入れ条件 2

## 備考

補足・参考リンク・注意点（任意）。
```

## 関連スキル

- `commit-and-git`: コミットメッセージ・PR 操作の規約
- `issue-branch-pr-flow`: パッチ以外の実装作業の Issue / PR フロー
- `issue-model-signature`: Issue / PR 本文の署名規約
- `refresh-skills`: スキル改変後の整合性検査
