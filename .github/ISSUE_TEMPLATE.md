---
name: タスク
about: 実装・改善・リファクタリング・修正・ドキュメントなどあらゆる作業を起票する
title: "type(scope): 短い日本語"
labels: ""
assignees: ""
---

<!--
タイトル形式: type(scope): 短い日本語

  type は次のいずれか:
    feat / fix / perf / refactor / docs / style / test / chore / ci / build

  scope は変更範囲:
    workspace / numsec / shaperd / singrain / roomy / xtask / design-system / crates / clap-wrapper-builder など

  短い日本語の説明:
    - 体言止めは使用しない（〜する / 〜修正 / 〜追加 / 〜削除 / 〜実装 / 〜廃止 等、動作の意味を持たせる）
    - emoji は使用不可
    - 1 行で完結させる
    - 例: chore(ci): Github Workflow の不整合を修正
    - 例: feat(numsec): plugin と gui を monorepo に移行
    - 例: refactor(xtask): Standalone Target を物理削除

本文記述方針:
  - 主観的表現（私の見立て、推す、妥当と思う等）は使用しない
  - 客観的な論点・根拠・制約・対応事項として記述する
  - 必要性、作業範囲、受け入れ条件は確認可能な事実・仕様・制約に基づいて書く
-->

✳︎ ${会社名} ${モデル名} ${バージョン名}

## 背景

なぜこの作業が必要か、客観的な論点・根拠・関連 Issue/PR を 1〜3 文で書く。

## 作業範囲

- やること 1
- やること 2

## 受け入れ条件

各条件は task list（`- [ ]` チェックボックス）で書き、達成時にチェックする。

- [ ] 受け入れ条件 1
- [ ] 受け入れ条件 2

## 備考

補足・参考リンク・注意点（任意）。
