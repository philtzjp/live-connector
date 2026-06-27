import { EXAMPLE_QUERIES, LOM_SCHEMA } from "@live-connector/lom-schema"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { ServerDeps } from "../deps"

/**
 * `schema` ツール: LOM グラフスキーマと例クエリを返す。
 * エージェントは query を書く前にこれを参照して、ラベル・プロパティ・リレーションを把握する。
 */
export function registerSchemaTool(server: McpServer, _deps: ServerDeps): void {
    server.registerTool(
        "schema",
        {
            title: "LOM グラフスキーマ",
            description:
                "Live Object Model のグラフスキーマ（ラベル・プロパティ r/w・リレーション・enum）と例クエリを返す。Cypher クエリを書く前にこれを参照する。",
        },
        async () => ({
            content: [
                {
                    type: "text",
                    text: JSON.stringify(
                        { schema: LOM_SCHEMA, examples: EXAMPLE_QUERIES },
                        null,
                        2,
                    ),
                },
            ],
        }),
    )
}
