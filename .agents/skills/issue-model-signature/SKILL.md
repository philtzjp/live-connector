---
name: issue-model-signature
description: GitHub Issue 本体、Issue コメント、PR 本文、PR コメントを書く・更新するときに参照する。本文先頭に `✳︎ <会社名> <モデル名> <バージョン>` 形式の署名行を入れ、1 行空けて本文を続ける規約を定義する。モデル名がバージョン番号を含む場合は `<バージョン>` を省略する。例: `✳︎ Anthropic Claude Opus 4.7` / `✳︎ OpenAI GPT-5.5`。
---

# Issue / PR / コメントのモデル署名

## 原則

1. MUST: GitHub Issue 本体、Issue コメント、PR 本文、PR コメントの先頭行に、書き手であるエージェント自身の署名を `✳︎ <会社名> <モデル名> <バージョン>` 形式で入れる
2. MUST: 署名行の次に空行を 1 行入れ、その後に本文を続ける
3. MUST: モデル名がバージョン番号を含む場合（例: `GPT-5.5`）は `<バージョン>` 部分を省略する
4. MUST: 署名は U+2733 EIGHT SPOKED ASTERISK (`✳︎`) で始める
5. NEVER: 署名を本文の途中・末尾に置かない
6. NEVER: 署名行と本文の間の空行を省略しない
7. NEVER: 署名行に日時、ID、装飾文字、その他追加情報を含めない

## 形式

```
✳︎ <会社名> <モデル名> <バージョン>

<本文>
```

## 例

Anthropic Claude Opus 4.7 の場合:

```
✳︎ Anthropic Claude Opus 4.7

対応方針 ...
```

OpenAI GPT-5.5 の場合（モデル名にバージョンが含まれるため `<バージョン>` 部分を省略）:

```
✳︎ OpenAI GPT-5.5

対応方針 ...
```

## 主なエージェントの署名（参考）

| エージェント | 署名 |
| --- | --- |
| Anthropic Claude Opus 4.8 | `✳︎ Anthropic Claude Opus 4.8` |
| Anthropic Claude Opus 4.7 | `✳︎ Anthropic Claude Opus 4.7` |
| Anthropic Claude Sonnet 4.6 | `✳︎ Anthropic Claude Sonnet 4.6` |
| Anthropic Claude Haiku 4.5 | `✳︎ Anthropic Claude Haiku 4.5` |
| Anthropic Claude Fable 5 | `✳︎ Anthropic Claude Fable 5` |
| OpenAI GPT-5.5 | `✳︎ OpenAI GPT-5.5` |
| OpenAI GPT-5.2-Codex | `✳︎ OpenAI GPT-5.2-Codex` |
