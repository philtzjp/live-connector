# philtzjp/live-connector

<img src="https://github.com/philtzjp/.github/blob/main/images/philtz.png?raw=true" width="150px" alt="Philtz Logo">

live-connectorは、Ableton Live を Cypher 風クエリで操作する MCP サーバー（Ableton Extensions SDK ベース）です。

> live-connector is a Cypher-style MCP server that lets AI agents query and edit an Ableton Live Set, built on the Ableton Extensions SDK.

---

## 概要

Ableton Live の **Extensions SDK**（Live と並走する Node.js プロセス）の中に **MCP サーバー**を常駐させ、外部の AI エージェントから Live Set（トラック・クリップ・デバイス・MIDI ノート・デバイスパラメータ等）を読み書きできるようにするプロジェクトです。

Live Object Model（LOM）を **プロパティグラフ**として捉え、アクセスは **Cypher サブセットの宣言的クエリ**で行います。型ごとに大量のツールを並べるのではなく、表現力をクエリ言語とスキーマ内省に寄せることで、エージェントが「やりたいこと」を自分で見つけて操作できる設計を狙います。

```cypher
-- 例: "Drums" トラックの Operator の Cutoff を読む
MATCH (:Track {name:"Drums"})-[:HAS_DEVICE]->(:Device {name:"Operator"})-[:HAS_PARAM]->(p:Parameter {name:"Cutoff"})
RETURN p.value, p.min, p.max
```

## ステータス

**設計フェーズ（未実装）。** 現時点ではアーキテクチャとツール設計を固めている段階で、実装コードはまだありません。

## アーキテクチャ概略

```
AI エージェント / MCP クライアント
      │  MCP over localhost (WebSocket または HTTP+SSE)
      ▼
Ableton Extension (Node.js, activate() 内で MCP サーバーを起動)
   ├─ Cypher クエリエンジン（読み取り: MATCH … WHERE … RETURN）
   ├─ 型付き書き込みツール（set_* / create / delete / write_notes …）
   └─ schema 内省（ラベル・プロパティ・リレーション・例クエリ）
      ▼
Ableton Live （Extension Host 経由で Live Set を操作）
```

## 前提・セットアップ

> **重要:** Ableton Extensions SDK 本体は本リポジトリに**同梱していません**。各自 Ableton から入手し、`ableton-sdk/`（`.gitignore` 済み）に配置してください。

- Node.js ≥ 24.14.1
- Ableton Live（Extensions 対応の Beta ビルド）+ Preferences → Extensions → Developer Mode 有効化
- Ableton Extensions SDK 配布物（`ableton-create-extension` / `ableton-extensions-sdk` / `ableton-extensions-cli`）

## ディレクトリ構成

```text
.
├── ableton-sdk/            # Ableton 提供の SDK 一式（非同梱・gitignore）
├── AGENTS.md               # AI エージェント向け作業規約（CLAUDE.md は symlink）
├── .agents/skills/         # 採用スキルの正本（.claude/skills は相対 symlink）
├── .github/ISSUE_TEMPLATE/ # タスク起票テンプレート
├── lefthook.yaml           # コミット前 / コミットメッセージ検証
├── LICENSE                 # MIT（自作分） + Ableton SDK の第三者条項
└── README.md
```

## ライセンス

本リポジトリの**自作コード・ドキュメント・アセットは [MIT](./LICENSE)** です。

ただし **Ableton Extensions SDK は © Ableton AG であり MIT ではありません**。SDK は Ableton Extensions SDK License に従う第三者コンポーネントで、本リポジトリには同梱せず（`ableton-sdk/` を `.gitignore`）、各自 Ableton から入手する必要があります。詳細は [LICENSE](./LICENSE) の Third-Party Components を参照してください。
