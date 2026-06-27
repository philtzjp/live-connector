---
name: skill-selection
description: 上流リポジトリ (`philtzjp/skills`) から自プロジェクトへスキル群を導入する際、新規スキルを採用するか判断する際、既存スキルが自プロジェクトで不要になり除外する際に参照する。プロジェクトの技術スタック・運用ルール・チーム慣習に照らして必要なスキルのみを残し、`AGENTS.md` / `CLAUDE.md` のスキル表と `.agents/skills/` / `.claude/skills/` 配下を一致させる選定手順を定義する。
---

# スキルの選定

## 発火タイミング

1. 自プロジェクトを新規セットアップしてスキル群を初期導入する
2. 上流リポジトリで新規スキルが追加され、自プロジェクトに取り込むか判断する
3. プロジェクトの技術スタック・運用方針が変わり、既存スキルの要不要を再評価する
4. 不要なスキルを除外する

## 採用判断

1. MUST: 各スキルの frontmatter `description`、発火タイミング、本文 MUST/NEVER を読み、自プロジェクトの技術スタック・運用ルール・チーム慣習と照合する
2. MUST: 採用基準を満たさないスキルは導入しない（unused skill はメンテ対象と矛盾源を増やすので除外する）
3. SHOULD: 「いつか必要かもしれない」段階のスキルは導入を保留する; 実際に使う段階で取り込む
4. NEVER: 上流から無条件に全スキルを取り込まない
5. NEVER: 採用していないスキル名を運用ルール・コードルール・他スキル本文から参照する（参照する場合はそのスキルも採用する）

## 新規導入

1. MUST: 上流リポジトリ `philtzjp/skills` から対象スキル `<name>` の `SKILL.md` を取得する（`git show`、`gh api`、上流クローン参照など）
2. MUST: 自プロジェクトの `.agents/skills/<name>/SKILL.md` として配置する
3. MUST: `.claude/skills/<name>` を `../../.agents/skills/<name>` への相対シンボリックリンクとして作成する
4. MUST: `AGENTS.md` または `CLAUDE.md`（実体ファイル）のスキル表に新規スキル名と発火タイミングの行を追加する
5. MUST: `refresh-skills` の整合性検査を実行する
6. NEVER: `.claude/skills/<name>` だけ作成して `.agents/skills/<name>/SKILL.md` の正本を欠落させる

## 削除

1. MUST: `.agents/skills/<name>/` ディレクトリを削除する
2. MUST: `.claude/skills/<name>` のシンボリックリンクを削除する
3. MUST: `AGENTS.md` または `CLAUDE.md`（実体ファイル）のスキル表から該当行を削除する
4. MUST: 当該スキル名を参照する他スキル・運用ルール・コードルールを検索し、参照を更新または削除する
5. MUST: `refresh-skills` の整合性検査を実行する

## AGENTS.md / CLAUDE.md の取り扱い

1. MUST: スキル表の正本は実体ファイル側に置く
2. IF: `AGENTS.md` が存在し `CLAUDE.md` がそのシンボリックリンク; THEN MUST: `AGENTS.md` を編集する
3. IF: `CLAUDE.md` のみ存在する; THEN MUST: `CLAUDE.md` を編集する
4. MUST: スキル表は採用済みスキル（`.agents/skills/<name>/SKILL.md` が存在するもの）と完全一致させる
5. MUST: 採用しないスキルに依存する記述（コードルール / 運用ルール / パッケージ規約など）は、採用するスキル構成に合わせて書き換える
6. NEVER: スキル表に未導入のスキルを記載しない
7. NEVER: 採用していないスキルに依存する MUST / NEVER ルールを `AGENTS.md` / `CLAUDE.md` に残す

## 関連スキル

- `refresh-skills`: スキル追加・削除後の整合性検査と修復手順
- `skill-escalation`: スキル本体の改良提案を上流に起票する手順
- `commit-and-git`: 変更内容のコミット手順
