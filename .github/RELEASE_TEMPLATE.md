<!--
GitHub Release のリリースノート雛形。GitHub は Release にテンプレートを自動適用しないため、
リリース作成時にこの雛形をコピーして使う。

方針:
  - 署名は付けない（AGENTS.md 運用ルール 8 の署名対象は Issue / PR の本体・コメントのみ）。
  - 主観的表現は使わない。客観的な変更事実・制約で書く。
  - タグは `v<セマンティックバージョン>`、リリース名は `live-connector v<バージョン>`。
  - 配布物 `.ablx` を添付し、ダウンロードリンクは実タグ URL に置き換える。
  - Ableton Live Beta + Extensions SDK（beta）前提のため pre-release で公開する。
  - バージョン更新・`llm/version/<v>.md` 作成は運用ルール 6（セマンティックバージョニング）に従う。
  - `<...>` を具体内容に置き換える。該当のないセクションは削除してよい。
-->

live-connector v<バージョン> は、<前バージョン> 以降の<変更の総括を 1〜2 文で客観的に書く>。

## 変更内容

### <カテゴリ 1（例: クエリ・読み取り）>

- <変更 1>
- <変更 2>

### <カテゴリ 2（例: 生成・構造操作）>

- <変更 1>

## 制約

- <SDK・実装上の制約 1>
- <制約 2>

## インストール

1. このリリースに添付されている [`live-connector-<バージョン>.ablx`](https://github.com/philtzjp/live-connector/releases/download/v<バージョン>/live-connector-<バージョン>.ablx) をダウンロードします。
2. Ableton Live の Preferences → Extensions に `.ablx` をドロップします。
3. Developer Mode を OFF にして Ableton Live を再起動します。
4. MCP クライアントから `http://127.0.0.1:7799/api/v1/mcp` に接続します。
   - ヘルスチェック: `http://127.0.0.1:7799/health`

Claude Code では、初回に次の登録を行います。

```sh
claude mcp add --transport http live-connector http://127.0.0.1:7799/api/v1/mcp --scope project
```

## 更新手順

1. このリリースに添付されている [`live-connector-<バージョン>.ablx`](https://github.com/philtzjp/live-connector/releases/download/v<バージョン>/live-connector-<バージョン>.ablx) をダウンロードします。
2. Ableton Live の Preferences → Extensions に新しい `.ablx` をドロップします。
3. Ableton Live を再起動します。
4. URL が `http://127.0.0.1:7799/api/v1/mcp` のままであれば、Claude Code の再登録は不要です。

## 備考

補足・既知の問題・pre-release の理由など（任意）。
