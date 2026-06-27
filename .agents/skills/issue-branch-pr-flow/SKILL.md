---
name: issue-branch-pr-flow
description: パッチバグフィクス以外の実装作業を行うときに必ず参照する。Issue 起票、専用ブランチ作成、実装、PR 作成、同期状態確認、ahead/behind がない場合のみマージする標準フローを定義する。巨大モノレポ、複数会社・複数人で同時実装する状況、機能追加、仕様変更、リファクタリング、設計変更、依存関係変更、DB/API/UI/アーキテクチャ変更で使用する。
---

# Issue / Branch / PR フロー

# 原則
1. MUST: パッチバグフィクス以外の実装作業は、Issue 起票 → ブランチ作成 → 実装 → PR 作成 → ahead/behind 確認 → マージの順で進める
2. MUST: 判断に迷う作業はパッチバグフィクスではなく通常フローとして扱う
3. NEVER: 通常フロー対象の実装を、Issue なし・専用ブランチなし・PR なしで進めない
4. NEVER: デフォルトブランチ上で通常フロー対象の実装を開始しない
5. MUST: Git 操作、コミット、ブランチ、マージ、リベース、プッシュを行う場合は `commit-and-git` スキルも併用する
6. MUST: 既存の未コミット変更を確認し、ユーザーまたは他作業者の変更を巻き込まない
7. MUST: 会社・チーム・担当領域をまたぐ変更では、Issue と PR に影響範囲、検証内容、残リスクを明記する

# 例外

以下のすべてを満たす場合のみ、パッチバグフィクスとしてこのフローを省略できる:

1. 既存挙動の明確な不具合を直す最小差分である
2. 仕様追加、設計変更、データモデル変更、API 契約変更、依存関係変更、権限・課金・認証の変更を含まない
3. 変更範囲が局所的で、他チームの作業や統合予定リポジトリに影響しない
4. Issue 化して合意形成する価値より、即時修正する価値が明らかに高い
5. ユーザーがパッチ対応を明示している、または既に同等の Issue / PR 文脈が存在する

# 開始前

1. MUST: `git status --short --branch` で作業ツリー、現在ブランチ、upstream 状態を確認する
2. MUST: `git fetch --prune` を実行する
3. MUST: デフォルトブランチ、現在ブランチ、リモート追跡ブランチの状態を確認する
4. IF: 未コミット変更がある; THEN MUST: 変更内容と所有者を確認し、今回の作業に無関係な変更をステージ・コミット・修正しない
5. IF: 現在ブランチがデフォルトブランチでない; THEN MUST: そのブランチが今回の作業用か確認する
6. IF: GitHub CLI など Issue / PR 操作に必要なツールや権限がない; THEN MUST: ユーザーに不足を報告し、ローカル実装だけ先行してよいか確認する

# Issue

1. MUST: 既存 Issue があるか確認する
2. IF: 既存 Issue がない; THEN MUST: 実装前に Issue を作成する
3. MUST: Issue には目的、背景、受け入れ条件、影響範囲、検証方針を記載する
4. MUST: 複数会社・複数領域に影響する場合は、担当境界とレビュー観点を Issue に記載する
5. SHOULD: Issue は実装単位が大きすぎない粒度に分割する
6. NEVER: Issue が曖昧なまま大きな変更へ着手しない

# ブランチ

1. MUST: Issue 番号を含む専用ブランチを作成する
2. SHOULD: ブランチ名は `<type>/<issue-number>-<short-kebab-summary>` にする
3. SHOULD: `type` は `feat`、`fix`、`refactor`、`docs`、`test`、`chore`、`ci`、`build` のいずれかにする
4. MUST: ブランチ作成前にベースブランチが最新であることを確認する
5. NEVER: 複数 Issue の実装を 1 ブランチに混在させない

# 実装

1. MUST: Issue の受け入れ条件に沿って最小の論理単位で実装する
2. MUST: 作業中にスコープが広がった場合は Issue / PR の説明を更新し、必要なら別 Issue に分割する
3. MUST: 変更に応じてテスト、Lint、型チェック、E2E、ドキュメント更新を行う
4. MUST: データモデル、環境変数、アーキテクチャ、API、E2E など他スキルの発火条件に該当する場合は該当スキルも併用する
5. NEVER: レビューしづらい巨大差分を、理由なく 1 PR にまとめない

# PR

1. MUST: 実装後、PR を作成する
2. MUST: PR は Issue にリンクし、`Closes #<issue-number>` または同等の自動クローズ記法を含める
3. MUST: PR 本文に概要、変更内容、検証結果、影響範囲、レビューしてほしい観点、残リスクを記載する
4. MUST: GitHub CLI で PR を作成する場合は `gh pr create --body "<本文>"` または `gh pr create --body-file <file>` を使用し、PR 本文を明示する
5. NEVER: PR 本文に `Co-Authored-By` を含めない。`--fill` やエディタ生成により `Co-Authored-By` が混入する可能性がある場合は使用しない
6. MUST: PR 作成前にローカルブランチを upstream へ push する
7. SHOULD: PR は Draft で早めに作り、実装完了後に Ready for review へ切り替える
8. NEVER: レビュー・CI・必要な検証を迂回してマージしない

# マージ前チェック

1. MUST: `git fetch --prune` を再実行する
2. MUST: `git status --short --branch` でローカルブランチが upstream に対して ahead / behind / diverged していないことを確認する
3. MUST: PR ブランチがベースブランチに対して behind していないことを確認する
4. MUST: PR が mergeable で、コンフリクトがなく、必須 CI / レビュー / チェックが通っていることを確認する
5. IF: ローカルブランチが upstream に対して ahead; THEN MUST: push して再確認する
6. IF: ローカルブランチが upstream に対して behind または diverged; THEN MUST: ユーザーに報告し、rebase / merge / pull の方針確認後に同期する
7. IF: PR ブランチがベースブランチに対して behind; THEN MUST: ベースブランチを取り込んで検証を再実行する
8. IF: コンフリクト、失敗 CI、未解決レビュー、未確認の ahead / behind がある; THEN NEVER: マージしない

# マージ

1. MUST: マージ直前に `git fetch --prune` と ahead / behind 確認をもう一度行う
2. MUST: ahead / behind がないこと、PR が mergeable であること、CI / レビュー条件を満たすことを確認してからマージする
3. MUST: PR のマージ方式は merge commit を使用する
4. MUST: マージコミットは `gh pr merge <番号> --merge --subject "merge(scope): 説明（日本語、短い文）" --body ""` で件名と空の本文を明示する; NEVER: デフォルトのマージコミットメッセージ（`Merge pull request #N from ...`）を使用しない; NEVER: 件名・本文に PR 番号（`#N`）や Issue 番号など参照を含めない; NEVER: `merge` プレフィクスでマージであることが明示されるため、説明文に「マージ」と書かない（NG: `merge(api): foo をマージ` → OK: `merge(api): foo を追加`）
5. NEVER: squash merge / squash commit を使用しない。ただしユーザーが明示的に指示した場合のみ例外とする
6. MUST: マージ後、Issue が自動クローズされているか確認する
7. SHOULD: 作業ブランチの削除は、リモート状態とユーザー意図を確認してから行う
