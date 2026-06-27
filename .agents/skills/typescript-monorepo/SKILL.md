---
name: typescript-monorepo
description: 新規パッケージの追加、`turbo.json` / `pnpm-workspace.yaml` / `tsconfig` の編集、`apps/` や `packages/` の構成変更、責務パッケージ（`log` / `error` / `prompt` / `env` / `db`）の配置・参照を行うときに参照する。Turborepo + pnpm のベストプラクティス、`workspace:*` プロトコル、JIT コンパイル方針を定義する。
---

# TypeScript モノレポ
1. MUST: Turborepo + pnpm ワークスペースのベストプラクティスに従う
2. MUST: パッケージマネージャーは pnpm に統一する; ロックファイルは `pnpm-lock.yaml` のみコミットする
3. MUST: ワークスペース構成を `pnpm-workspace.yaml` で定義する
4. MUST: `apps/`（デプロイ可能なアプリケーション）と `packages/`（共有ライブラリ・設定）の分離を維持する
5. NEVER: デプロイ可能なアプリを `packages/` に配置しない; NEVER: 共有ライブラリを `apps/` に配置しない
6. MUST: `@<org>/` プレフィックスを持つスコープ付きパッケージ名を使用する; すべての内部パッケージは MUST: `"private": true` を設定する
7. MUST: 各パッケージの `package.json` に `exports` を定義する; `main` より `exports` を優先する
8. MUST: `packages/tsconfig/` に共有 TypeScript 設定を作成する; 各パッケージは MUST: それを継承する
9. MUST: 共通責務を担う以下のパッケージを `packages/` 配下に必ず配置する: `log`（ログ集約）、`error`（エラー集約）、`prompt`（AI プロンプト集約）、`env`（環境変数集約）、`db`（データベース集約）
10. MUST: 上記責務パッケージを利用する側は `@<org>/log`・`@<org>/error`・`@<org>/prompt`・`@<org>/env`・`@<org>/db` を `workspace:*` で依存に追加する; NEVER: 該当責務を呼び出し側で再実装しない
11. MUST: 依存関係を考慮したタスクパイプラインを持つ `turbo.json` を作成する
12. MUST: 内部依存関係には `workspace:*` プロトコルを使用する
13. SHOULD: デフォルトは JIT（Just-in-Time）コンパイルパターンを採用する; IF: コンパイル済み（`tsc` → `dist/`）への切り替えを明示的に要求された; THEN: 切り替える
14. NEVER: ネストしたパッケージを作成しない; NEVER: Turborepo をグローバルにインストールしない — `pnpm exec turbo` またはルートの devDependency を使用する
