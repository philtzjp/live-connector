---
name: Issue
about: Report a bug, propose a change, or file work to be done
title: "type(scope): "
labels: ""
assignees: ""
---

<!--
Title: type(scope): description

  type is one of:
    feat / fix / perf / refactor / docs / style / test / chore / ci / build

  scope comes from the place you change:
    extension (apps/extension) / the package name under packages/, such as cypher,
    lom-schema, env, error, log, json or tsconfig / a top-level directory name,
    such as docs or .github / repo for the whole repository

  The description is written in Japanese, in one short line:
    - End it with an action (〜する / 〜を追加 / 〜を修正 / 〜を削除), not a bare noun
    - No emoji, no parentheses, no issue numbers

Body:
  - Keep the headings below. They are checked as they are written here
  - Write verifiable facts, specifications and constraints, not opinions
  - Replace the signature line with your own if an agent is writing; a person may delete it

Reporting a bug? Put these in 背景 so we can reproduce it:
  - Ableton Live version and build
  - live-connector version, as shown by `curl http://127.0.0.1:7799/health`
  - OS and MCP client
  - The Cypher statement or tool call you ran, what you expected, and what happened
-->

✳︎ ${vendor} ${model} ${version}

## 背景

<!-- Start from the first line with "- " bullets -->

- Why this is needed, as verifiable facts
- Reference a related issue or pull request as "#<number>" if there is one

## 作業範囲

- What to do 1
- What to do 2

## 受け入れ条件

<!-- Write each condition as a "- [ ]" task list item and tick it when it is met -->

- [ ] Acceptance criterion 1
- [ ] Acceptance criterion 2

## 備考

Reference links, caveats or related issues. Delete this section if there are none.
