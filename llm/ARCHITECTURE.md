# live-connector Architecture

この文書は、現在の実装コードを基準に live-connector の構成、責務境界、実行時フローを記録する。データモデルの詳細は `llm/models.yaml` を正本とする。

## システム概要

live-connector は Ableton Extensions SDK 上で動作する Node.js extension である。Extension Host 内で Node.js 標準 `http` サーバーを起動し、`@modelcontextprotocol/sdk` 同梱の `StreamableHTTPServerTransport` 経由で MCP ツールを提供する。MCP ツールは Live Object Model (LOM) をプロパティグラフとして扱い、Cypher サブセットで読み取り、型付きツールで書き込みを行う。

```mermaid
flowchart LR
    agent["AI agent / MCP client"]
    http["Node http server<br/>apps/extension/src/server/http.ts"]
    mcp["MCP server<br/>apps/extension/src/server/mcp.ts"]
    tools["MCP tools<br/>schema / get_overview / query / set_* / write_notes"]
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

`activate()` は Ableton SDK の `initialize()` で `ExtensionContext` を得る。`loadEnv()` は host/port/token を検証し、`startMcpHttpServer()` は `/health` と `/api/v1/mcp` を公開する。`LIVE_CONNECTOR_MCP_TOKEN` が設定されている場合のみ、`/api/v1/mcp` に Bearer 認証が適用される。

## HTTP エンドポイント

| method | path | 認証 | 用途 |
| --- | --- | --- | --- |
| `GET` | `/health` | なし | `application/health+json` のヘルスチェック |
| `POST` | `/api/v1/mcp` | `LIVE_CONNECTOR_MCP_TOKEN` 設定時のみ Bearer | Streamable HTTP MCP endpoint |

## MCP ツール

| tool | 種別 | 説明 |
| --- | --- | --- |
| `schema` | read | `LOM_SCHEMA` と `EXAMPLE_QUERIES` を返す |
| `get_overview` | read | tempo、scale、track 概要、scene/cue count を返す |
| `query` | read | Cypher サブセットを parse/evaluate して行集合を返す |
| `set_song` | write | Song の `tempo` を書き込む |
| `set_track` | write | Track の `name` / `arm` / `mute` / `solo` を書き込む |
| `set_clip` | write | Clip / AudioClip の mutable property を書き込む |
| `set_scene` | write | Scene の `name` を書き込む |
| `set_device_parameter` | write | Parameter の `value` を書き込む |
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
    participant tool as set_* / write_notes
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
        context->>adapter: setProperty() or clip.notes = descriptions
        adapter->>live: SDK write
        tool-->>client: ok payload
    end
```

書き込み系 `select` は対象ノード集合を解決する selector であり、`RETURN` は単一ノード変数に限定される。`set_*` は対象件数が `CONFIRM_THRESHOLD` を超える場合に `confirm:true` を要求する。`write_notes` はちょうど 1 つの `MidiClip` を要求し、notes を replace する。

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
- Cypher サブセットは `MATCH ... [WHERE ...] RETURN ... [LIMIT n]`、有向 relationship、可変長 hop、基本比較演算を対象にする。
- `LomGraphAdapter.seeds()` で開始できるラベルは `Song` / `Track` family / `Clip` family / `Device` family / `Scene` / `CuePoint` である。
- `ableton-sdk/` は外部配布物であり、workspace には同梱しない。
