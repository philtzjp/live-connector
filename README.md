# philtzjp/live-connector

<img src="https://github.com/philtzjp/.github/blob/main/images/philtz.png?raw=true" width="150px" alt="Philtz Logo">

live-connector は、Ableton Live を AI エージェントから操作するための MCP サーバーです。

配布済みの `.ablx` を Ableton Live にインストールすると、Live 起動時に `http://127.0.0.1:7799/api/v1/mcp` で MCP endpoint が起動します。Claude Code などの MCP クライアントから、Live Set のトラック、クリップ、デバイス、MIDI ノート、デバイスパラメータを読み書きできます。

> live-connector is an MCP server for controlling Ableton Live from AI agents. Install the `.ablx` file, restart Live, and connect your MCP client to `http://127.0.0.1:7799/api/v1/mcp`.

## 必要なもの

- Ableton Live（Extensions 対応の Beta ビルド）
- [live-connector v2.17.1](https://github.com/philtzjp/live-connector/releases/tag/v2.17.1) の `.ablx`
- Claude Code などの HTTP MCP クライアント

## インストール

1. [`live-connector-2.17.1.ablx`](https://github.com/philtzjp/live-connector/releases/download/v2.17.1/live-connector-2.17.1.ablx) をダウンロードします。
2. Ableton Live を起動し、Preferences → Extensions を開きます。
3. `Choose file` から `.ablx` を選択、または `.ablx` を Extensions ページへドロップします。
4. Developer Mode を OFF にします。
5. Ableton Live を再起動します。

![Ableton Live Extensions settings showing where to select the .ablx file and turn Developer Mode off](docs/assets/settings-instructions.png)

Live 起動後、ブラウザで次の URL を開きます。

<http://127.0.0.1:7799/health>

ページに次のような JSON が表示されれば、live-connector は起動しています。

```json
{"status":"pass","version":"2.17.1","description":"live-connector MCP server","tools":{ ... },"structure":{ ... }}
```

## Claude Code で使う

初回のみ、プロジェクトルートで MCP server を登録します。

```sh
claude mcp add --transport http live-connector http://127.0.0.1:7799/api/v1/mcp --scope project
```

登録後に Claude Code を再起動します。URL が変わらない限り、`.ablx` の再インストールや Live 再起動のたびに再登録する必要はありません。

## できること

- Live Set の概要取得（構造ダイジェスト・接続先識別を含む）: `get_overview`
- Live Object Model のスキーマ確認: `schema`
- Cypher サブセットによる読み取り: `query`（集計 count/min/max/avg/sum・ORDER BY・DISTINCT・SKIP/LIMIT）
- トラック・シーン・デバイスの生成／削除／複製、Session / Arrangement クリップの作成と削除
- 内蔵デバイス（音源・エフェクト）の挿入: `insert_device`、Simpler へのサンプル読み込み: `load_sample`
- MIDI ノートの書き込み（replace / merge / clear_range・境界検証）とサーバー側変換（transpose / quantize / velocity など）: `transform_notes`
- トラック・クリップ・シーン・デバイスパラメータ・Cue Point の更新（ミキサー volume/pan/send も Parameter として書き込み可）
- Arrangement 範囲のオーディオ書き出し（同期／`background` ジョブ）: `render_audio`
- 書き込み履歴の参照: `get_write_history`、変更前へのロールバック: `restore_snapshot`、複数書き込みの一括実行: `batch`
- デバイス状態の保存と再適用: `save_device_state` / `apply_device_state`

例:

```cypher
MATCH (:Track {name:"Drums"})-[:HAS_DEVICE]->(:Device {name:"Operator"})-[:HAS_PARAM]->(p:Parameter {name:"Cutoff"})
RETURN p.value, p.min, p.max
```

## 注意点

- インストール済み `.ablx` を使う場合、Developer Mode は OFF にします。
- `localhost:7799` が起動しない場合は、Ableton Live を再起動し、`/health` を確認してください。
- v2.0.0 で `localhost:7799` が起動しない場合は、v2.0.1 以降の `.ablx` に更新してください。
- Ableton Extensions SDK v1.0.0-beta.0 には Browser API がないため、`.adv` / `.adg` / third-party plug-in のネイティブプリセットを Live へ直接読み込むことはできません。
- third-party plug-in の非公開内部状態や波形選択は保存・復元できません。`save_device_state` / `apply_device_state` の対象は SDK から見える host 公開パラメータに限定されます。
- SDK には MIDI 楽器トラックの合成出力を audio 化する手段（render / freeze / resample）がありません。`render_audio` は AudioTrack の pre-FX 音声のみ対象です。MIDI 楽器の実音を検証するには、Live 上で対象トラックを AudioTrack へ手動で resample / freeze してから `render_audio` を適用します（詳細は `llm/midi-audition.md`）。

## 開発

モノレポは pnpm + Turborepo で管理します。主なコマンド:

```sh
pnpm typecheck   # 全パッケージの型チェック
pnpm test        # vitest によるユニットテスト（実機・Ableton SDK 実体なしで完走）
pnpm lint        # Biome によるリント
pnpm format      # Biome によるフォーマット
```

`pnpm test` は `packages/cypher`（tokenizer / parser / evaluator / selectNodes）、`packages/lom-schema`（ラベル継承・サブタイプ判定）、`apps/extension`（フェイク SDK とフェイク MCP サーバーによるツール層）を検証します。cypher の評価器はフェイク `GraphAdapter` で駆動し、SDK 非依存で回帰を固定します。`typecheck` と `test` は lefthook の `pre-push` で実行します。

## ライセンス

本リポジトリの自作コード・ドキュメント・アセットは [MIT](./LICENSE) です。

Ableton Extensions SDK は Ableton AG の第三者コンポーネントであり、本リポジトリには同梱していません。詳細は [NOTICE](./NOTICE) を参照してください。
