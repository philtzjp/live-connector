<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/philtz-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/philtz.png">
  <img src="docs/assets/philtz-outline.png" width="96" alt="Philtz">
</picture>

# Contributing to live-connector

How to open issues, write commits, and send pull requests.<br>
<sub>Issue、コミット、PR の書き方と、コントリビューションの進め方をまとめています。</sub>

<p align="center"><a href="#en">Read more in English</a> · <a href="#ja">日本語で読む</a></p>

<a id="en"></a>

## English

> [!IMPORTANT]
> We accept pull requests only for work a maintainer has agreed to in an [issue](https://github.com/philtzjp/live-connector/issues) or a [discussion](https://github.com/philtzjp/live-connector/discussions). Pull requests without a prior agreement may be closed. The Extensions SDK is still in beta and the MCP tools keep changing, so this keeps review manageable.

### Workflow

Changes go through an issue, a branch, and a pull request.

1. Check for an existing issue, and open one if there is none.
2. Wait for a maintainer to agree on the issue and the approach.
3. Create a branch that includes the issue number, and implement the change.
4. Open a pull request that references the issue.
5. Once review and CI pass, a maintainer merges it.

### Writing conventions

Issues, branches, commits and pull requests follow one format. This keeps the history searchable and makes the output look the same whether a person or an agent wrote it.

<details>
<summary>Issues</summary>
<br>

Write the title in the same `type(scope): description` format as commit messages.

```text
OK  fix(cypher): 空文字列リテラルのパースエラーを修正する
NG  Cypher bug
NG  [Request] About device insertion
```

Write the body in four sections. The [issue template](.github/ISSUE_TEMPLATE.md) starts you off in this shape.

| Section | Contents |
| --- | --- |
| Background | Why it is needed, in one to three sentences |
| Scope | A bullet list of what to do |
| Acceptance criteria | Conditions that decide when it is done, as `- [ ]` checkboxes |
| Notes | Reference links or caveats. Omit if there are none |

Avoid opinions such as "I think" or "this seems reasonable"; write verifiable facts, specifications and constraints. Split an issue if it grows too large.

For bug reports, include the following so we can reproduce the problem:

- Ableton Live version and build
- live-connector version, as shown by `curl http://127.0.0.1:7799/health`
- OS and MCP client
- The Cypher query or tool call, what you expected, and what happened

</details>

<details>
<summary>Branches</summary>
<br>

Name branches `<type>/<issue number>-<short English summary>`. Each branch handles exactly one issue.

```text
fix/128-empty-string-literal
feat/131-insert-device-into-chain
```

</details>

<details>
<summary>Commit messages</summary>
<br>

Write one line in the form `type(scope): description`. The description is a short sentence in Japanese, following the existing history.

```text
OK  feat(extension): Rack のチェーン内へのデバイス挿入を追加する
OK  docs(llm): undo ステップの制約を記録する
NG  feat(apps/extension): デバイス挿入
NG  fix: バグ修正 (#128)
NG  update code ✨
```

`type` is one of the following. `merge` is reserved for maintainers' merge commits.

| type | Use for |
| --- | --- |
| `feat` | New features |
| `fix` | Bug fixes |
| `perf` | Performance improvements |
| `refactor` | Improvements that do not change behavior |
| `docs` | Documentation |
| `style` | Formatting and similar fixes |
| `test` | Tests |
| `chore` | Anything else |
| `ci` | CI configuration |
| `build` | Build configuration |

`scope` comes from the directory you changed. Do not use `apps` or `packages` themselves, slash-separated paths such as `apps/extension`, or folder names that do not exist.

| Changed | scope |
| --- | --- |
| `apps/extension` | `extension` |
| Anything under `packages/`, such as `packages/cypher` | The package name, such as `cypher` |
| A top-level directory such as `llm/`, `.github/` or `.agents/` | The directory name, such as `llm`, `.github` or `.agents` |
| The whole repository | `repo` |

End the description with an action, such as 〜する, 〜を追加 or 〜を修正, not with a bare noun. Do not include parentheses, emoji, the words フェーズ or Phase, signatures such as `Co-Authored-By`, or tool session URLs.

Split commits by package or feature. Do not mix unrelated changes in one commit, and add files by name instead of using `git add .` or `git add -A`.

</details>

<details>
<summary>Pull requests</summary>
<br>

- Use the same `type(scope): description` format for the title as for commit messages.
- Follow the [pull request template](.github/PULL_REQUEST_TEMPLATE.md) and write the background, scope, acceptance criteria and notes.
- Reference the issue in the background as `#128`. Do not use auto-close keywords such as `Closes #128`; a maintainer closes the issue after merging.
- For each acceptance criterion, describe how it was met and which command verified it.
- Describe the impact and any remaining risks.
- Open the pull request as a draft while you work, and switch it to Ready for review when it is done.

Pull requests are merged with a merge commit, not squashed, so every commit message in the pull request stays in the history.

</details>

> [!TIP]
> After cloning, run `git config core.hooksPath .vite-hooks` once. The commit message format is then checked locally on every commit.

### Development

<details>
<summary>Development setup</summary>
<br>

Requires Node.js 24.16+ and pnpm. The Ableton Extensions SDK is not bundled; place it in `ableton-sdk/` yourself. See [NOTICE](NOTICE).

```sh
pnpm install
pnpm typecheck
pnpm test        # runs without Live or the real SDK
pnpm lint
pnpm package     # writes the .ablx to apps/extension/dist/
```

The hooks enabled by `git config core.hooksPath .vite-hooks` check the following:

| Hook | Checks |
| --- | --- |
| `commit-msg` | Commit message format |
| `pre-commit` | `.env*` files are encrypted with dotenvx |
| `pre-push` | `pnpm typecheck` and `pnpm test` pass |

</details>

<details>
<summary>Repository layout</summary>
<br>

A pnpm and Turborepo monorepo. Deployable apps live in `apps/`, shared libraries in `packages/`.

| Path | Contents |
| --- | --- |
| `apps/extension` | The Extension loaded by Live: HTTP server, MCP tools, OSC integration, capture |
| `packages/cypher` | Tokenizer, parser and evaluator for the Cypher subset |
| `packages/lom-schema` | LOM label definitions, inheritance and the query contract |
| `packages/env` | zod schema for environment variables |
| `packages/error`, `packages/log`, `packages/json` | Shared errors, logging, and `bigint`-safe JSON serialization |
| `packages/tsconfig` | Shared TypeScript configuration |
| `llm/` | Design documents and the data model |

</details>

<details>
<summary>Design documents</summary>
<br>

Read the relevant documents before changing how things fit together. They are written in Japanese.

| Document | Contents |
| --- | --- |
| [llm/ARCHITECTURE.md](llm/ARCHITECTURE.md) | Structure, responsibility boundaries, runtime flow |
| [llm/models.yaml](llm/models.yaml) | Source of truth for the data model |
| [llm/device-catalog.md](llm/device-catalog.md) | Built-in device catalog and how it matches real Live installs |
| [llm/midi-audition.md](llm/midi-audition.md) | Turning a MIDI track into audio for listening |
| [llm/version/](llm/version) | Per-version change notes |

</details>

<details>
<summary>Code conventions</summary>
<br>

The full rules are in [AGENTS.md](AGENTS.md). The most important ones:

- Variables use `snake_case`, functions `camelCase`, types `PascalCase`, and environment variables `CONSTANT_CASE`. Indent with four spaces.
- Prefer descriptive names, even when they get long.
- Use `packages/log` for logging, `packages/error` for errors, `packages/env` for environment variables, and `packages/json` for JSON serialization. Do not reimplement them in other packages.
- When an environment variable or an external API response is missing, raise an error instead of falling back to a default.
- Add dependencies with `pnpm add`, not by editing `package.json` directly.
- Update `llm/models.yaml` when the data model changes, and `llm/ARCHITECTURE.md` when the structure changes.

</details>

<details>
<summary>Working with an agent</summary>
<br>

Coding agents read [AGENTS.md](AGENTS.md) and [`.agents/skills/`](.agents/skills). The conventions in this guide are a human-oriented summary of them.

When an agent writes an issue or a pull request, put a signature such as `✳︎ Anthropic Claude Opus 4.8` on the first line, followed by one blank line and then the body. For commits written entirely by an agent, set `--author` to the agent.

```sh
git commit --author="Claude <noreply@anthropic.com>" -m "fix(cypher): 空文字列リテラルのパースエラーを修正する"
```

</details>

<a id="ja"></a>

## 日本語

> [!IMPORTANT]
> PR は、[Issue](https://github.com/philtzjp/live-connector/issues) か [Discussion](https://github.com/philtzjp/live-connector/discussions) でメンテナーが合意した作業だけ受け付けます。事前の合意がない PR は、閉じることがあります。Extensions SDK がまだ beta で MCP のツールも変わり続けているため、レビューできる量に保つための方針です。

### 進め方

変更は、Issue、ブランチ、PR の順に進めます。

1. 既存の Issue がないか確認し、なければ Issue を作ります。
2. メンテナーが Issue の内容と進め方に合意するのを待ちます。
3. Issue 番号を含むブランチを作って実装します。
4. PR を作り、Issue を参照します。
5. レビューと CI が通ったら、メンテナーがマージします。

### 書き方

Issue、ブランチ、コミット、PR の書き方を揃えています。履歴を後から検索しやすくし、人とエージェントのどちらが書いても同じ形になるようにするためです。

<details>
<summary>Issue</summary>
<br>

タイトルはコミットメッセージと同じ `type(scope): 説明` の形式で書きます。

```text
OK  fix(cypher): 空文字列リテラルのパースエラーを修正する
NG  Cypher のバグ
NG  【要望】デバイス挿入について
```

本文は次の 4 つの節で書きます。[Issue テンプレート](.github/ISSUE_TEMPLATE.md) を使うと、この形で始まります。

| 節 | 書くこと |
| --- | --- |
| 背景 | なぜ必要か。1〜3 文で書きます |
| 作業範囲 | やることの箇条書き |
| 受け入れ条件 | 完了を判断できる条件。`- [ ]` のチェックボックスで書きます |
| 備考 | 参考リンクや注意点。なければ省略します |

「〜と思う」「〜が妥当」のような主観的な書き方はせず、確かめられる事実、仕様、制約で書いてください。1 つの Issue が大きくなりすぎる場合は分けてください。

バグ報告には、再現できるように次の情報を含めてください。

- Ableton Live のバージョンとビルド
- live-connector のバージョン。`curl http://127.0.0.1:7799/health` で確認できます
- OS と MCP クライアント
- 実行した Cypher かツール呼び出し、期待した結果、実際の結果

</details>

<details>
<summary>ブランチ</summary>
<br>

Issue 番号を含めて `<type>/<Issue 番号>-<短い英語の要約>` の形にします。1 つのブランチで扱う Issue は 1 つだけにします。

```text
fix/128-empty-string-literal
feat/131-insert-device-into-chain
```

</details>

<details>
<summary>コミットメッセージ</summary>
<br>

`type(scope): 説明` の 1 行で書きます。説明は日本語の短い文にします。

```text
OK  feat(extension): Rack のチェーン内へのデバイス挿入を追加する
OK  docs(llm): undo ステップの制約を記録する
NG  feat(apps/extension): デバイス挿入
NG  fix: バグ修正 (#128)
NG  update code ✨
```

`type` は次のどれかです。`merge` はメンテナーがマージコミットにだけ使います。

| type | 使う場面 |
| --- | --- |
| `feat` | 新機能 |
| `fix` | バグ修正 |
| `perf` | 性能改善 |
| `refactor` | 振る舞いを変えない改善 |
| `docs` | ドキュメント |
| `style` | フォーマットなどの修正 |
| `test` | テスト |
| `chore` | その他 |
| `ci` | CI の設定 |
| `build` | ビルドの設定 |

`scope` は変更したディレクトリで決めます。`apps` や `packages` そのもの、`apps/extension` のようなスラッシュ付きの階層、実在しないフォルダ名は使いません。

| 変更した場所 | scope |
| --- | --- |
| `apps/extension` | `extension` |
| `packages/cypher` など `packages/` 配下 | `cypher` のようにパッケージ名 |
| `llm/`、`.github/`、`.agents/` などリポジトリ直下のディレクトリ | `llm`、`.github`、`.agents` のようにディレクトリ名 |
| リポジトリ全体 | `repo` |

説明は動作で終え、「〜する」「〜を追加」「〜を修正」のように書きます。名詞だけで終えません。カッコ、emoji、「フェーズ」「Phase」、`Co-Authored-By` などの署名、ツールのセッション URL は含めません。

コミットはパッケージや機能ごとに分けます。無関係な変更を 1 つのコミットにまとめず、`git add .` や `git add -A` を使わずにファイルを指定して追加してください。

</details>

<details>
<summary>PR</summary>
<br>

- タイトルはコミットメッセージと同じ `type(scope): 説明` の形式にします。
- 本文は [PR テンプレート](.github/PULL_REQUEST_TEMPLATE.md) に従い、背景、作業範囲、受け入れ条件、備考を書きます。
- 背景で対象の Issue を `#128` のように参照します。`Closes #128` のような英語の自動クローズ記法は使いません。Issue はマージ後にメンテナーがクローズします。
- 受け入れ条件には、各条件をどう満たしたか、どのコマンドで検証したかを添えます。
- 影響範囲と、残っているリスクを書きます。
- 作業中の段階で Draft として作り、完成したら Ready for review に切り替えてください。

マージは merge commit で行います。squash はしないので、PR 内の各コミットメッセージもそのまま履歴に残ります。

</details>

> [!TIP]
> clone したら `git config core.hooksPath .vite-hooks` を一度実行してください。コミットメッセージの形式を、コミットのたびに手元で検査できます。

### 開発

<details>
<summary>開発環境</summary>
<br>

Node.js 24.16 以上と pnpm が必要です。Ableton Extensions SDK は同梱していないので、各自で `ableton-sdk/` に配置します。扱いは [NOTICE](NOTICE) を参照してください。

```sh
pnpm install
pnpm typecheck
pnpm test        # Live と SDK の実体なしで完走します
pnpm lint
pnpm package     # apps/extension/dist/ に .ablx を生成します
```

`git config core.hooksPath .vite-hooks` で有効にした hook は、次の内容を検査します。

| hook | 検査する内容 |
| --- | --- |
| `commit-msg` | コミットメッセージの形式 |
| `pre-commit` | `.env*` が dotenvx で暗号化されていること |
| `pre-push` | `pnpm typecheck` と `pnpm test` が通ること |

</details>

<details>
<summary>リポジトリ構成</summary>
<br>

pnpm と Turborepo のモノレポです。`apps/` にはデプロイするアプリ、`packages/` には共有ライブラリを置きます。

| パス | 内容 |
| --- | --- |
| `apps/extension` | Live に読み込まれる Extension 本体。HTTP サーバー、MCP ツール、OSC 連携、録音を含みます |
| `packages/cypher` | Cypher サブセットの tokenizer、parser、evaluator |
| `packages/lom-schema` | LOM のラベル定義と継承、クエリの契約 |
| `packages/env` | 環境変数の zod スキーマ |
| `packages/error`, `packages/log`, `packages/json` | エラー、ログ、`bigint` を扱える JSON 直列化の共通実装 |
| `packages/tsconfig` | 共有の TypeScript 設定 |
| `llm/` | 設計文書とデータモデル |

</details>

<details>
<summary>設計文書</summary>
<br>

構成を変える前に、関係する文書を読んでください。

| 文書 | 内容 |
| --- | --- |
| [llm/ARCHITECTURE.md](llm/ARCHITECTURE.md) | 構成、責務の境界、実行時の流れ |
| [llm/models.yaml](llm/models.yaml) | データモデルの正本 |
| [llm/device-catalog.md](llm/device-catalog.md) | 内蔵デバイスカタログと実機との整合 |
| [llm/midi-audition.md](llm/midi-audition.md) | MIDI トラックを audio にして試聴する手順 |
| [llm/version/](llm/version) | バージョンごとの変更記録 |

</details>

<details>
<summary>コード規約</summary>
<br>

詳しくは [AGENTS.md](AGENTS.md) にあります。特に守ってほしいのは次の点です。

- 変数は `snake_case`、関数は `camelCase`、型は `PascalCase`、環境変数は `CONSTANT_CASE` で書きます。インデントは 4 スペースです。
- 名前は、長くなっても意味がわかるものにします。
- ログは `packages/log`、エラーは `packages/error`、環境変数は `packages/env`、JSON 直列化は `packages/json` を使います。各パッケージで独自に実装しないでください。
- 環境変数や外部 API のレスポンスが欠けているとき、既定値で補わずにエラーにします。
- パッケージは `package.json` を直接編集せず、`pnpm add` で追加します。
- データモデルを変えたら `llm/models.yaml` を、構成を変えたら `llm/ARCHITECTURE.md` を更新します。

</details>

<details>
<summary>エージェントで作業する場合</summary>
<br>

コーディングエージェントは [AGENTS.md](AGENTS.md) と [`.agents/skills/`](.agents/skills) を読んで作業します。この文書の規約も、そこから人向けにまとめ直したものです。

エージェントが Issue や PR を書いた場合は、本文の先頭行に `✳︎ Anthropic Claude Opus 4.8` のような署名を入れ、空行を 1 行挟んで本文を続けます。エージェントだけで書いたコミットは、`--author` でエージェントの種類を明示します。

```sh
git commit --author="Claude <noreply@anthropic.com>" -m "fix(cypher): 空文字列リテラルのパースエラーを修正する"
```

</details>
