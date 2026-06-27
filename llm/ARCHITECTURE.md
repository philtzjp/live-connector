# live-connector Architecture

この文書は、現在の実装コードを基準に live-connector の構成、責務境界、実行時フローを記録する。データモデルの詳細は `llm/models.yaml` を正本とする。

## システム概要

live-connector は Ableton Extensions SDK 上で動作する Node.js extension である。Extension Host 内で Node.js 標準 `http` サーバーを起動し、`@modelcontextprotocol/sdk` 同梱の `StreamableHTTPServerTransport` 経由で MCP ツールを提供する。MCP ツールは Live Object Model (LOM) をプロパティグラフとして扱い、Cypher サブセットで読み取り、型付きツールで書き込みを行う。

```mermaid
flowchart LR
    agent["AI agent / MCP client"]
    http["Node http server<br/>apps/extension/src/server/http.ts"]
    mcp["MCP server<br/>apps/extension/src/server/mcp.ts"]
    tools["MCP tools<br/>schema / get_overview / query / render_audio / search_presets / create_* / delete_* / set_* / write_notes"]
    cypher["@live-connector/cypher<br/>parser / evaluator / selector"]
    adapter["LomGraphAdapter<br/>apps/extension/src/lom/adapter.ts"]
    sdk["Ableton Extensions SDK"]
    live["Ableton Live Set"]
    schema["@live-connector/lom-schema<br/>LOM_SCHEMA"]
    env["@live-connector/env<br/>typed environment"]
    error["@live-connector/error<br/>AppError / ProblemDetails / McpError"]
    log["@live-connector/log<br/>scoped logger"]

    agent -->|"POST /api/v1/mcp"| http
    http -->|"StreamableHTTPServerTransport"| mcp
    mcp --> tools
    tools --> cypher
    tools --> schema
    cypher --> adapter
    adapter --> sdk
    sdk --> live
    http --> env
    tools --> error
    http --> log
    tools --> log
```

## パッケージ境界

```mermaid
flowchart TB
    root["workspace root<br/>pnpm / turbo / biome"]
    app["@live-connector/extension<br/>apps/extension"]
    cypher["@live-connector/cypher<br/>packages/cypher"]
    lom_schema["@live-connector/lom-schema<br/>packages/lom-schema"]
    env["@live-connector/env<br/>packages/env"]
    error["@live-connector/error<br/>packages/error"]
    log["@live-connector/log<br/>packages/log"]
    tsconfig["@live-connector/tsconfig<br/>packages/tsconfig"]
    ableton["ableton-sdk/<br/>external file dependency"]

    root --> app
    root --> cypher
    root --> lom_schema
    root --> env
    root --> error
    root --> log
    root --> tsconfig
    app --> cypher
    app --> lom_schema
    app --> env
    app --> error
    app --> log
    app --> ableton
    cypher --> error
    env --> error
```

| パッケージ | 責務 |
| --- | --- |
| `apps/extension` | Ableton extension の起動、HTTP/MCP サーバー、MCP ツール登録、LOM adapter 実装 |
| `packages/cypher` | Cypher サブセットの tokenizer/parser/AST/evaluator。Ableton SDK へ依存しない |
| `packages/lom-schema` | LOM グラフスキーマ、ラベル、プロパティ、リレーション、例クエリの正本 |
| `packages/env` | 環境変数の zod 検証と型付き `Env` の提供 |
| `packages/error` | `AppError` 系のエラー定義、HTTP 用 RFC 9457 Problem Details 変換、MCP 用構造化エラー変換 |
| `packages/log` | scope 付き logger の生成と標準出力/標準エラーへの集約 |
| `packages/tsconfig` | 共有 TypeScript 設定 |

## 起動フロー

```mermaid
sequenceDiagram
    participant host as Ableton Extension Host
    participant extension as activate()
    participant env as packages/env
    participant http as Node http server
    participant mcp as MCP server
    participant live as Ableton Live

    host->>extension: activate(ActivationContext)
    extension->>live: initialize(activation, API_VERSION)
    extension->>env: loadEnv(process.env)
    env-->>extension: Env
    extension->>http: startMcpHttpServer({ deps, env, log })
    http-->>extension: ServerInfo
    http->>mcp: createMcpServer(deps) per request
```

`activate()` は Ableton SDK の `initialize()` で `ExtensionContext` を得る。`loadEnv()` は loopback host と port を検証し、`startMcpHttpServer()` は `/health` と `/api/v1/mcp` を公開する。`/api/v1/mcp` は Host header が loopback host と設定 port に一致し、Origin header が存在する場合は loopback origin であるリクエストのみ受け付ける。

## 配布フロー

```mermaid
sequenceDiagram
    participant user as Developer
    participant pnpm as pnpm package
    participant turbo as turbo run package
    participant build as apps/extension build:production
    participant cli as extensions-cli package
    participant dist as dist/live-connector-<version>.ablx

    user->>pnpm: pnpm package
    pnpm->>turbo: turbo run package
    turbo->>build: tsx build.ts --production
    build-->>turbo: dist/extension.js
    turbo->>cli: extensions-cli package . -o dist/live-connector-<version>.ablx
    cli-->>dist: manifest.json + dist/extension.js
```

`pnpm package` は root script から Turborepo の `package` task を実行する。`@live-connector/extension` の package script は production bundle を生成した後、`manifest.json` の `name` と `version` から `.ablx` の出力名を決め、SDK CLI の `extensions-cli package` に渡す。`.ablx` は `apps/extension/dist/` に生成される。

## HTTP エンドポイント

| method | path | 認証 | 用途 |
| --- | --- | --- | --- |
| `GET` | `/health` | なし | `application/health+json` のヘルスチェック |
| `POST` | `/api/v1/mcp` | loopback Host / Origin header 検証 | Streamable HTTP MCP endpoint |

## MCP ツール

| tool | 種別 | 説明 |
| --- | --- | --- |
| `schema` | read | `LOM_SCHEMA` と `EXAMPLE_QUERIES` を返す |
| `get_overview` | read | tempo、scale、track 概要、アレンジクリップ、CuePoint、scene/cue count を返す |
| `query` | read | Cypher サブセットを parse/evaluate して行集合を返す |
| `render_audio` | read/render | 1 つの AudioTrack の arrangement pre-FX 音声を WAV にレンダリングしてパスを返す |
| `search_presets` | read/fs | 指定 root 配下のプリセット候補ファイルを列挙する。適用は行わない |
| `create_arrangement_clip` | write | 1 つの MidiTrack / AudioTrack に arrangement Clip を startTime/duration 指定で作成する |
| `delete_arrangement_clip` | write | 1 つの arrangement Clip を削除する |
| `create_cue_point` | write | time 指定で CuePoint を作成し、任意で `name` を設定する |
| `delete_cue_point` | write | 1 つの CuePoint を削除する |
| `create_clip` | write | 空の MidiTrack ClipSlot に指定 length の空 MidiClip を生成する |
| `set_song` | write | Song の `tempo` を書き込む |
| `set_track` | write | Track の `name` / `arm` / `mute` / `solo` を書き込む |
| `set_clip` | write | Clip / AudioClip の mutable property を書き込む |
| `set_scene` | write | Scene の `name` を書き込む |
| `set_cue_point` | write | CuePoint の `name` を書き込む |
| `set_device_parameter` | write | Parameter の `value` を書き込む |
| `save_device_state` | write/fs | 1 つの Device の公開 DeviceParameter 値を `environment.storageDirectory` に JSON 保存する |
| `apply_device_state` | write/fs | 保存済み DeviceParameter 値を 1 つの Device の同名パラメータへ再適用する |
| `write_notes` | write | 1 つの MidiClip の notes を replace する |

## 読み取りフロー

```mermaid
sequenceDiagram
    participant client as MCP client
    participant query as query tool
    participant parser as parseQuery()
    participant evaluator as evaluate()
    participant adapter as LomGraphAdapter
    participant live as Ableton Live Set

    client->>query: cypher
    query->>parser: parseQuery(cypher)
    parser-->>query: Query AST
    query->>evaluator: evaluate(ast, adapter)
    evaluator->>adapter: seeds(label)
    evaluator->>adapter: expand(node, relationships)
    evaluator->>adapter: getProperty(node, property)
    adapter->>live: SDK read
    live-->>adapter: values
    evaluator-->>query: Row[]
    query-->>client: { count, rows }
```

`packages/cypher` は SDK 非依存の `GraphAdapter<N>` 越しにグラフを評価する。`LomGraphAdapter` は Ableton SDK の `Song` / `Track` / `Clip` / `Device` / `DeviceParameter` / `NoteDescription` を `LomNode` として包み、LOM schema に定義されたラベルとプロパティへ変換する。

## 書き込みフロー

```mermaid
sequenceDiagram
    participant client as MCP client
    participant tool as render_audio / create_* / delete_* / set_* / save/apply_device_state / write_notes
    participant parser as parseQuery()
    participant selector as selectNodes()
    participant adapter as LomGraphAdapter
    participant context as ExtensionContext
    participant live as Ableton Live Set

    client->>tool: select + mutation payload
    tool->>parser: parseQuery(select)
    parser-->>tool: Query AST
    tool->>selector: selectNodes(ast, adapter)
    selector->>adapter: seeds / expand / getProperty
    selector-->>tool: LomNode[]
    tool->>tool: validate required label and guardrails
    alt preview
        tool-->>client: preview payload
    else commit
        tool->>context: withinTransaction()
        context->>adapter: setProperty(), create/delete clip, create/delete cue, clip.notes = descriptions
        adapter->>live: SDK write/create
        tool-->>client: ok payload
    end
```

単一対象ツールの `select` は対象ノード集合を解決する selector であり、`RETURN` は単一ノード変数に限定される。`render_audio` はちょうど 1 つの `AudioTrack` を要求し、指定 beat 範囲の arrangement pre-FX 音声を WAV として生成する。`create_arrangement_clip` はちょうど 1 つの `MidiTrack` または `AudioTrack` を要求し、arrangement timeline に `startTime` / `duration` 指定で clip を作成する。`delete_arrangement_clip` は `HAS_ARRANGEMENT_CLIP` で辿れる clip だけを削除し、session clip は対象外とする。`create_cue_point` / `delete_cue_point` は Song の CuePoint を作成・削除する。`create_clip` はちょうど 1 つの空 `ClipSlot` を要求し、親が `MidiTrack` である場合のみ空 `MidiClip` を生成する。`set_*` は対象件数が `CONFIRM_THRESHOLD` を超える場合に `confirm:true` を要求する。`set_cue_point` は `CuePoint.name` を書き込む。`save_device_state` / `apply_device_state` はちょうど 1 つの `Device` を要求し、公開 `DeviceParameter` の値だけを JSON 保存・再適用する。`write_notes` はちょうど 1 つの `MidiClip` を要求し、notes を replace する。

## データ所有

```mermaid
flowchart LR
    lom_schema["LOM_SCHEMA<br/>labels / properties / relationships"]
    adapter["LomGraphAdapter<br/>runtime mapping"]
    cypher_ast["Query AST<br/>packages/cypher"]
    tools["Tool input/output shapes<br/>apps/extension/src/tools"]
    models["llm/models.yaml<br/>LLM-facing inventory"]

    lom_schema --> adapter
    cypher_ast --> tools
    lom_schema --> models
    cypher_ast --> models
    tools --> models
    adapter --> models
```

`llm/models.yaml` は実装の代替ではなく、LLM が参照するモデル目録である。TypeScript 型や zod schema を変更した場合は、対応する項目を更新する。

## 現在の制約

- MCP tool error は `toMcpError()` により `{ error, detail, hint?, validProperties?, validRelationships?, validStartLabels? }` 形式で返る。HTTP の `status` / `type` / `instance` は MCP tool error には含めない。
- HTTP 層のエラーは `toProblemDetails()` により RFC 9457 Problem Details 形式を維持する。
- `query` の `RETURN` は射影を許可するが、書き込み系 `select` の `RETURN` は単一ノード変数に限定される。
- `Clip.startTime` / `startMarker` / `endMarker` / `loopStart` / `loopEnd` は SDK 上 read-only であり、arrangement clip の移動・トリムは直接ツール化しない。必要な場合は削除と再作成で表現する。
- Ableton Extensions SDK には Browser API とネイティブプリセット読込 API が無いため、`search_presets` はファイル列挙のみを行う。`.adv` / `.adg` / third-party plug-in preset の適用は対象外とする。
- Device state snapshot は SDK に公開される `DeviceParameter` の値だけを対象とし、plug-in の非公開内部状態は保存・復元しない。
- Cypher サブセットは `MATCH ... [WHERE ...] RETURN ... [LIMIT n]`、有向 relationship、可変長 hop、基本比較演算を対象にする。
- `LomGraphAdapter.seeds()` で開始できるラベルは `Song` / `Track` family / `Clip` family / `Device` family / `Scene` / `CuePoint` である。
- `ableton-sdk/` は外部配布物であり、workspace には同梱しない。
