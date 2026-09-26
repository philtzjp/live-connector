<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/philtz-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/philtz.png">
  <img src="docs/assets/philtz-outline.png" width="96" alt="Philtz">
</picture>

# live-connector

An MCP server that lets AI agents read and write an Ableton Live Set as a graph.<br>
<sub>Ableton Live の Live Set を、AI エージェントがグラフとして読み書きできるようにする MCP サーバーです。</sub>

<p align="center"><a href="#en">Read more in English</a> · <a href="#ja">日本語で読む</a></p>

<a id="en"></a>

## English

<p align="center">
  <a href="https://github.com/philtzjp/live-connector"><img src="https://img.shields.io/github/stars/philtzjp/live-connector?style=social" alt="Star live-connector on GitHub"></a><br>
  <sub>If live-connector helps you, a star keeps us going.</sub>
</p>

> [!IMPORTANT]
> live-connector is early-stage software built on Ableton Extensions SDK 1.0.0-beta.1, and it requires a Live Beta build with Extensions support. If you are upgrading from v2.x, note that v3.0.0 consolidated the MCP surface into four tools and removed every v2.x tool name.

### Quick start

1. Get the `.ablx`. [Releases](https://github.com/philtzjp/live-connector/releases) has pre-releases up to v3.0.0. For the latest 3.2.1, run `pnpm package` in the repository; it writes the file to `apps/extension/dist/`.
2. In Live, open Preferences → Extensions and choose the `.ablx`, or drop it onto the page.
3. Turn Developer Mode OFF and restart Live.

![Ableton Live Extensions settings showing where to select the .ablx file and the Developer Mode switch](docs/assets/settings-instructions.png)

4. Check that it is running, and register it with Claude Code.

```sh
curl http://127.0.0.1:7799/health
claude mcp add --transport http live-connector http://127.0.0.1:7799/api/v1/mcp --scope project
```

> [!CAUTION]
> The MCP server has no authentication. Do not forward port 7799 to other hosts, and keep AbletonOSC off your LAN.

If `/health` returns `{"status":"pass","version":"3.2.1",...}`, the server is up.

> [!TIP]
> You only need to register the MCP server once. Reinstalling the `.ablx` keeps the same URL.

Restart Claude Code, open a Live Set, and try asking:

- "List the tracks and devices in this Live Set."
- "Create a MIDI track called Bass and add Wavetable to it."
- "Mute the Drums track. Actually, undo that."
- "What is the current value and range of Operator's Cutoff?"

### Technology

<details>
<summary>The Live Set is a graph</summary>
<br>

Tracks, devices, parameters and clips are exposed as nodes and relationships, and agents read and write them with the same Cypher.

```cypher
MATCH (:Track {name:"Drums"})-[:HAS_DEVICE]->(:Device {name:"Operator"})-[:HAS_PARAM]->(p:Parameter {name:"Cutoff"})
RETURN p.value, p.min, p.max
```

```cypher
MATCH (t:MidiTrack {name:"Bass"}) CREATE (t)-[:HAS_DEVICE]->(d:Device {name:"Wavetable"})
```

| Live | Graph |
| --- | --- |
| Track | `Track` node, with `MidiTrack` and `AudioTrack` as subtypes |
| Device on a track | `(:Track)-[:HAS_DEVICE]->(:Device)` |
| Device parameter | `(:Device)-[:HAS_PARAM]->(:Parameter)` |
| Mixer volume, pan and sends | `(:Track)-[:HAS_MIXER]->(:Mixer)-[:HAS_VOLUME\|HAS_PAN\|HAS_SEND]->(:Parameter)` |
| Rack chain | `(:Device)-[:HAS_CHAIN]->(:Chain)` |
| Playback state | virtual label `Transport` |
| Write history | virtual label `WriteEvent` |
| Capture job | virtual label `RenderJob` |

`meta` returns the complete list of labels and the grammar at runtime.

</details>

<details>
<summary>It runs inside Live</summary>
<br>

live-connector is a Live Extension, so there is no Remote Script or separate process to set up. The MCP server starts with Live and serves Streamable HTTP on a loopback address.

</details>

<details>
<summary>Every write can be undone</summary>
<br>

The SDK has no undo API, so live-connector records the operations that reverse each `do` write under a `writeId`. `undo` applies them newest first, or for a specific `writeId`. Each write is marked `full`, `partial` or `none` depending on how completely it can be restored; `partial` and `none` require confirmation. Query the history with `MATCH (e:WriteEvent) RETURN e`.

The log is kept as JSONL in the Extension's storage directory, up to 200 entries. When the SDK gains an undo API, this mechanism will be replaced.

</details>

<details>
<summary>SDK and OSC, each for what it does best</summary>
<br>

Set editing goes through the SDK. Transport control and Main output capture go through AbletonOSC, because the SDK has no API for them. OSC writes are read back to confirm they took effect, and a failed write is never retried automatically on the other backend.

Main output capture records the finished signal, including MIDI instruments and the devices on Main, by recording the Resampling input in real time. Pass `source:"main"` to `render` and go through two steps.

```json
{"source":"main","startTime":0,"endTime":64,"preview":true}
```

```json
{"source":"main","startTime":0,"endTime":64,"background":true,"confirm":true,"planId":"plan-...","requestId":"capture-001"}
```

`startTime` and `endTime` are zero-based quarter-note beats. During capture a temporary track is created and loop, punch and record mode are changed, then everything is restored. Other writes, `undo`, and another `render` are rejected until it finishes. Check progress with `MATCH (j:RenderJob {id:"..."}) RETURN j.phase, j.progressFraction`.

</details>

### Specification

<details>
<summary>MCP tools</summary>
<br>

| Tool | Purpose |
| --- | --- |
| `meta` | Service info, LOM schema, Cypher grammar, allowed `CALL` procedures, examples, and a Live Set overview |
| `do` | Cypher reads and writes, and `CALL` for transport |
| `render` | Pre-FX rendering of an AudioTrack, or real-time capture of the Main output |
| `undo` | Reverts `do` writes |

The recommended flow is `meta`, then `do` reads, `do` writes, `render`, and `undo` when needed.

</details>

<details>
<summary>Cypher</summary>
<br>

| Kind | Supported |
| --- | --- |
| Read | `MATCH … RETURN` with projection, aggregation, `ORDER BY`, `SKIP` and `LIMIT`. Results are truncated at 500 rows without `LIMIT` |
| Write | `SET`, `CREATE`, `DELETE`, `COPY` |
| Pattern | Directed relationships, variable-length hops, basic comparison operators |
| Procedure | `CALL transport.play()`, `transport.seek()`, `render.cancel()` and others listed by `meta` |

</details>

<details>
<summary>Endpoints and settings</summary>
<br>

| Item | Value |
| --- | --- |
| MCP endpoint | `http://127.0.0.1:7799/api/v1/mcp`, Streamable HTTP |
| Health check | `http://127.0.0.1:7799/health` |
| Enable AbletonOSC | `LIVE_CONNECTOR_OSC_ENABLED=true`. Off by default; everything else works without it |

</details>

<a id="ja"></a>

## 日本語

<p align="center">
  <a href="https://github.com/philtzjp/live-connector"><img src="https://img.shields.io/github/stars/philtzjp/live-connector?style=social" alt="Star live-connector on GitHub"></a><br>
  <sub>live-connector が役に立ったら、スターを付けてもらえると励みになります。</sub>
</p>

> [!IMPORTANT]
> live-connector は Ableton Extensions SDK 1.0.0-beta.1 の上で動く早期段階のソフトウェアで、Extensions に対応した Live の Beta ビルドが必要です。v2.x から更新する場合は注意してください。v3.0.0 で MCP ツールを 4 つに統合し、v2.x のツール名はすべて廃止しました。

### クイックスタート

1. `.ablx` を用意します。[Releases](https://github.com/philtzjp/live-connector/releases) には v3.0.0 までの pre-release があります。最新の 3.2.1 はリポジトリで `pnpm package` を実行すると `apps/extension/dist/` に生成されます。
2. Live の Preferences → Extensions で `.ablx` を選ぶか、ページにドロップします。
3. Developer Mode を OFF にして Live を再起動します。

![Ableton Live の Extensions 設定。.ablx を選ぶ場所と Developer Mode のスイッチ](docs/assets/settings-instructions.png)

4. 起動を確認し、Claude Code に登録します。

```sh
curl http://127.0.0.1:7799/health
claude mcp add --transport http live-connector http://127.0.0.1:7799/api/v1/mcp --scope project
```

> [!CAUTION]
> MCP サーバーに認証はありません。7799 番ポートを他のホストへ転送せず、AbletonOSC も LAN に公開しないでください。

`/health` が `{"status":"pass","version":"3.2.1",...}` を返せば起動しています。

> [!TIP]
> MCP の登録は初回だけで済みます。`.ablx` を入れ直しても URL は変わらないので、再登録は要りません。

Claude Code を再起動し、Live Set を開いた状態で次のように頼んでみてください。

- 「今の Live Set のトラックとデバイスを一覧にして」
- 「Bass という MIDI トラックを作って Wavetable を挿して」
- 「Drums トラックをミュートして。やっぱり戻して」
- 「Operator の Cutoff の現在値と範囲を教えて」

### テクノロジー

<details>
<summary>Live Set をグラフとして扱います</summary>
<br>

トラック、デバイス、パラメータ、クリップをノードと関係として公開し、エージェントは読み取りも書き込みも同じ Cypher で行います。

```cypher
MATCH (:Track {name:"Drums"})-[:HAS_DEVICE]->(:Device {name:"Operator"})-[:HAS_PARAM]->(p:Parameter {name:"Cutoff"})
RETURN p.value, p.min, p.max
```

```cypher
MATCH (t:MidiTrack {name:"Bass"}) CREATE (t)-[:HAS_DEVICE]->(d:Device {name:"Wavetable"})
```

| Live | グラフ |
| --- | --- |
| トラック | `Track` ノード。`MidiTrack` と `AudioTrack` はそのサブタイプです |
| トラック上のデバイス | `(:Track)-[:HAS_DEVICE]->(:Device)` |
| デバイスのパラメータ | `(:Device)-[:HAS_PARAM]->(:Parameter)` |
| ミキサーの音量、パン、センド | `(:Track)-[:HAS_MIXER]->(:Mixer)-[:HAS_VOLUME\|HAS_PAN\|HAS_SEND]->(:Parameter)` |
| Rack のチェーン | `(:Device)-[:HAS_CHAIN]->(:Chain)` |
| 再生状態 | 仮想ラベル `Transport` |
| 書き込み履歴 | 仮想ラベル `WriteEvent` |
| 録音ジョブ | 仮想ラベル `RenderJob` |

ラベルの完全な一覧と文法は、実行時に `meta` が返します。

</details>

<details>
<summary>Live の中で動きます</summary>
<br>

live-connector は Live の Extension なので、Remote Script や別プロセスを用意する必要はありません。MCP サーバーは Live と一緒に起動し、loopback アドレスで Streamable HTTP の接続を受け付けます。

</details>

<details>
<summary>すべての書き込みを取り消せます</summary>
<br>

SDK には undo の API がないため、`do` の書き込みごとに、それを打ち消す操作を `writeId` と一緒に記録します。`undo` は記録を新しいものから順に、または `writeId` を指定して適用します。書き込みは、元に戻せる度合いに応じて `full`、`partial`、`none` のどれかに分類され、`partial` と `none` の取り消しには確認が必要です。履歴は `MATCH (e:WriteEvent) RETURN e` で確認できます。

記録は Extension の保存領域に JSONL で最大 200 件まで残ります。SDK に undo の API が追加されたら、この仕組みを置き換える予定です。

</details>

<details>
<summary>SDK と OSC を得意分野で使い分けます</summary>
<br>

Set の編集は SDK で行います。再生の操作と Main 出力の録音は、SDK に API がないため AbletonOSC で行います。OSC での書き込みは読み戻して反映を確かめ、失敗した書き込みをもう一方の経路で自動的にやり直すことはしません。

Main 出力の録音では、MIDI 楽器の実音や、Main 上のデバイスを通した完成形の音を、Resampling 入力の実時間録音で取得します。`render` に `source:"main"` を渡し、計画の取得と実行の 2 段階で進めます。

```json
{"source":"main","startTime":0,"endTime":64,"preview":true}
```

```json
{"source":"main","startTime":0,"endTime":64,"background":true,"confirm":true,"planId":"plan-...","requestId":"capture-001"}
```

`startTime` と `endTime` は 0 始まりの四分音符の拍数です。録音中は一時トラックを作り、loop、punch、record mode を一時的に変更し、終了後に元へ戻します。録音が終わるまで、ほかの書き込み、`undo`、別の `render` は受け付けません。進捗は `MATCH (j:RenderJob {id:"..."}) RETURN j.phase, j.progressFraction` で確認します。

</details>

### 仕様

<details>
<summary>MCP ツール</summary>
<br>

| ツール | 役割 |
| --- | --- |
| `meta` | サービス情報、LOM スキーマ、Cypher の文法、使える `CALL` 手続き、例文、Live Set の概要を返します |
| `do` | Cypher で読み書きし、再生操作の `CALL` を実行します |
| `render` | AudioTrack を Pre-FX でレンダリングするか、Main 出力を実時間で録音します |
| `undo` | `do` の書き込みを取り消します |

推奨する順序は、`meta`、`do` での読み取り、`do` での書き込み、`render` です。必要なら最後に `undo` で戻します。

</details>

<details>
<summary>Cypher</summary>
<br>

| 種類 | 対応範囲 |
| --- | --- |
| 読み取り | `MATCH … RETURN`。射影、集計、`ORDER BY`、`SKIP`、`LIMIT` に対応します。`LIMIT` を省くと 500 行で打ち切ります |
| 書き込み | `SET`、`CREATE`、`DELETE`、`COPY` |
| パターン | 向きのある関係、可変長の hop、基本的な比較演算 |
| 手続き | `CALL transport.play()`、`transport.seek()`、`render.cancel()` など。一覧は `meta` が返します |

</details>

<details>
<summary>エンドポイントと設定</summary>
<br>

| 項目 | 値 |
| --- | --- |
| MCP エンドポイント | `http://127.0.0.1:7799/api/v1/mcp`。Streamable HTTP で接続します |
| ヘルスチェック | `http://127.0.0.1:7799/health` |
| AbletonOSC の有効化 | `LIVE_CONNECTOR_OSC_ENABLED=true`。既定では無効で、使わなくてもほかの機能は動きます |

</details>
