# philtzjp/live-connector

<img src="https://github.com/philtzjp/.github/blob/main/images/philtz.png?raw=true" width="150px" alt="Philtz Logo">

live-connectorは、Ableton Live を Cypher 風クエリで操作する MCP サーバー（Ableton Extensions SDK ベース）です。

> live-connector is a Cypher-style MCP server that lets AI agents query and edit an Ableton Live Set, built on the Ableton Extensions SDK.

---

## 概要

Ableton Live の **Extensions SDK**（Live と並走する Node.js プロセス）の中に **MCP サーバー**を常駐させ、外部の AI エージェントから Live Set（トラック・クリップ・デバイス・MIDI ノート・デバイスパラメータ等）を読み書きできるようにするプロジェクトです。

Live Object Model（LOM）を **プロパティグラフ**として捉え、アクセスは **Cypher サブセットの宣言的クエリ**で行います。型ごとに大量のツールを並べるのではなく、表現力をクエリ言語とスキーマ内省に寄せることで、エージェントが「やりたいこと」を自分で見つけて操作できる設計です。

```cypher
-- 例: "Drums" トラックの Operator の Cutoff を読む
MATCH (:Track {name:"Drums"})-[:HAS_DEVICE]->(:Device {name:"Operator"})-[:HAS_PARAM]->(p:Parameter {name:"Cutoff"})
RETURN p.value, p.min, p.max
```

## セットアップと起動

> **重要:** Ableton Extensions SDK 本体は本リポジトリに**同梱していません**。各自 Ableton から入手し、`ableton-sdk/`（`.gitignore` 済み）に配置してください。

### 前提

- インストール済み `.ablx` を使う場合: Ableton Live（Extensions 対応の Beta ビルド）
- リポジトリから `.ablx` を生成または開発起動する場合: Node.js（Extension Host は同梱ランタイム ≥ 24.14.1 を使用）+ pnpm
- リポジトリから `.ablx` を生成または開発起動する場合: Ableton Extensions SDK 配布物（`ableton-create-extension` / `ableton-extensions-sdk` / `ableton-extensions-cli`）を `ableton-sdk/` に配置

### 配布用 `.ablx` の生成

配布用アーカイブは SDK CLI の `extensions-cli package` で生成します。リポジトリルートで依存をインストールし、package task を実行すると、production build の後に `apps/extension/dist/live-connector-2.0.0.ablx` が生成されます。

```sh
pnpm install
pnpm package
```

出力ファイル名は `apps/extension/manifest.json` の `name` と `version` から決まります。`.ablx` には `manifest.json` と `manifest.entry` が指す `dist/extension.js` が含まれます。

### インストール型運用（CLI 不要）

1. 生成済みまたは配布済みの `live-connector-2.0.0.ablx` を用意する。
2. Ableton Live の Preferences → Extensions を開き、`.ablx` を Extensions ページへドロップしてインストールする。
3. Preferences → Extensions の **Developer Mode** を OFF にする。
4. Ableton Live を再起動する。
5. Live 起動時に Extension Host がインストール済み拡張を自動ロードし、Max Window に `MCP HTTP server listening ... :7799` が出る。
6. MCP クライアントから `http://127.0.0.1:7799/api/v1/mcp` に接続する。
   - ヘルスチェック: `http://127.0.0.1:7799/health`
   - `/api/v1/mcp` は loopback Host / Origin header のみを許可する

インストール型運用では `extensions-cli run` や `pnpm --filter @live-connector/extension start` による CLI 起動は不要です。`LIVE_CONNECTOR_MCP_HOST` と `LIVE_CONNECTOR_MCP_PORT` は未設定時に `127.0.0.1:7799` を使用します。

### Claude Code への登録

Claude Code へは初回に 1 回だけ project scope で HTTP MCP server を登録します。#35 以降は Authorization header は不要です。

```sh
claude mcp add --transport http live-connector http://127.0.0.1:7799/api/v1/mcp --scope project
```

登録または URL 変更などの MCP 設定変更後は Claude Code を再起動します。Live 再起動や拡張再インストールだけで URL が変わらない場合、Claude Code は同じ endpoint へ自動再接続します。

`.mcp.json`（`.gitignore` 済み）で管理する場合は、プロジェクトルートに次の設定を置きます。

```json
{
  "mcpServers": {
    "live-connector": {
      "type": "http",
      "url": "http://127.0.0.1:7799/api/v1/mcp"
    }
  }
}
```

### 更新

1. リポジトリルートで `pnpm package` を実行し、新しい `apps/extension/dist/live-connector-2.0.0.ablx` を生成する。
2. Ableton Live の Preferences → Extensions で新しい `.ablx` をドロップし、既存の live-connector を更新する。
3. Ableton Live を再起動する。
4. URL が `http://127.0.0.1:7799/api/v1/mcp` のままであれば、Claude Code 側の再登録と再起動は不要です。MCP 設定を変更した場合のみ Claude Code を再起動します。

### 開発モード（高速リロード）

Developer Mode は、Live が管理する Extension Host を停止し、開発者が `extensions-cli run` で Extension Host を起動するためのモードです。変更を短いサイクルで確認する開発時に使用します。

1. `apps/extension/.env`（`.gitignore` 済み）を作成する。
   ```
   EXTENSION_HOST_PATH=/Applications/Ableton Live 12 Beta.app   # 各自の Live のパス
   LIVE_CONNECTOR_MCP_HOST=127.0.0.1
   LIVE_CONNECTOR_MCP_PORT=7799
   ```
2. Live を起動し、Preferences → Extensions の **Developer Mode** を ON にする。
3. 拡張をビルド＆起動する。
   ```sh
   pnpm --filter @live-connector/extension start
   ```
4. 成功すると Max Window に `MCP HTTP server listening ... :7799` が出る。

開発モードの変更反映は CLI 起動で行います。インストール型運用では再パッケージ、`.ablx` 再インストール、Live 再起動で変更を反映します。

## プリセット探索とデバイス状態

Ableton Extensions SDK v1.0.0-beta.0 には Browser API、`BrowserItem`、`.adv` / `.adg` / third-party plug-in ネイティブプリセットを読み込む API はありません。`search_presets` は指定 root 配下のプリセット候補ファイルを列挙するだけで、Live や plug-in へ適用しません。

挿入済み Device の host 公開パラメータは、`save_device_state` で `environment.storageDirectory/device-states/` 配下に JSON 保存し、`apply_device_state` で同名パラメータへ再適用できます。対象は `DeviceParameter` として SDK に露出する値に限定され、Serum など third-party plug-in の非公開内部状態や波形選択は保存・復元されません。

## ディレクトリ構成

```text
.
├── apps/
│   └── extension/          # Ableton Extension（MCP サーバー本体・esbuild で cjs バンドル）
├── packages/
│   ├── cypher/             # Cypher サブセットのパーサ + 評価器（SDK 非依存）
│   ├── lom-schema/         # LOM グラフスキーマの単一定義
│   ├── env/                # 環境変数集約（zod）
│   ├── log/                # ログ集約
│   ├── error/              # エラー集約（RFC 9457 / MCP エラー変換）
│   └── tsconfig/           # 共有 TypeScript 設定
├── ableton-sdk/            # Ableton 提供の SDK 一式（非同梱・gitignore）
├── AGENTS.md               # AI エージェント向け作業規約（CLAUDE.md は symlink）
├── .agents/skills/         # 採用スキルの正本（.claude/skills は相対 symlink）
├── lefthook.yaml           # コミット前 / コミットメッセージ検証
├── turbo.json / pnpm-workspace.yaml
├── LICENSE                 # MIT（自作分） + Ableton SDK の第三者条項
└── README.md
```

## ライセンス

本リポジトリの**自作コード・ドキュメント・アセットは [MIT](./LICENSE)** です。

ただし **Ableton Extensions SDK は © Ableton AG であり MIT ではありません**。SDK は Ableton Extensions SDK License に従う第三者コンポーネントで、本リポジトリには同梱せず（`ableton-sdk/` を `.gitignore`）、各自 Ableton から入手する必要があります。詳細は [LICENSE](./LICENSE) の Third-Party Components を参照してください。
