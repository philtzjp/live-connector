---
name: api-design
description: API エンドポイントの設計・実装・変更を行うとき（HTTP ハンドラ、OpenAPI スキーマ、ヘルスチェック、ルーティング、認証方式の追加、MCP サーバーの構築など）に参照する。OpenAPI 準拠、RFC 9457 エラー、パスバージョニング、Bearer 認証、Spectral リント、HTTP サーバー層の統一と MCP トランスポートの選定を定義する。
---

# API 設計
1. MUST: OpenAPI に準拠する
2. MUST: エラーレスポンスの構造を RFC 9457 に準拠させる
3. MUST: URL パスバージョニングを使用する（例: `/api/v1/`）
4. SHOULD: パスはできる限り短くする; IF: やむを得ない場合; THEN MUST: `kebab-case` を使用する
5. MUST: 単数形の名詞を使用する（`/users` ではなく `/user`）
6. MUST: Bearer 認証を使用する
7. MUST: ヘルスチェックエンドポイントの構造を [draft-inadarei-api-health-check](https://datatracker.ietf.org/doc/html/draft-inadarei-api-health-check) に準拠させる
8. MUST: [Spectral](https://github.com/stoplightio/spectral) を使用して API をリントする
9. MUST: プロジェクトの HTTP サーバー層は単一の構成に統一する; MAY: フレームワーク（例: [Hono](https://hono.dev/)）を採用する、またはフレームワークを使わずランタイム標準のサーバー（例: Node.js の `http`）で実装する; IF: MCP サーバーを構築; THEN MUST: 採用した HTTP 層に対応する MCP トランスポートを使用する（フレームワーク採用時はそのアダプタ。例: Hono なら `@hono/mcp`。フレームワーク不採用時は SDK 同梱トランスポート。例: TypeScript SDK の `StreamableHTTPServerTransport`）
