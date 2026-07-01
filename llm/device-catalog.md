# 内蔵デバイスカタログの実機整合

`insert_device` の内蔵デバイスカタログ（`apps/extension/src/tools/devices.ts` の `BUILT_IN_DEVICE_CATALOG`）は手動管理の定数である。SDK v1.0.0-beta.0 に Browser（デバイス列挙）API が無いため、実機でのロード可否と自動同期しない。Live のバージョン・エディション差で乖離が生じ得る。

## 検証手段

`verify_device_catalog` ツール（`apps/extension/src/tools/catalog.ts`）を実行する。

- 一時 MidiTrack を作成し、`CATALOG_DEVICE_NAMES` 全項目を順に `insertDevice` で挿入試行する。
- 各デバイスは試行直後に削除し、最後に一時トラックも削除するため Set に残留しない（Live の undo 履歴には試行の記録が残る）。
- 応答: `{ total, insertable, failed, failedNames, results:[{name, insertable, error?}] }`。

実行は Live 実機（Extension Host 稼働）が必要。MCP クライアントから `verify_device_catalog` を 1 回呼ぶだけで全項目の挿入可否一覧が得られる。

## 結果の記録

検証を実行したら、以下の表に Live バージョンと `failedNames` を追記する。

| Live バージョン | 検証日 | failed 件数 | failedNames | 対応 |
| --- | --- | --- | --- | --- |
| （記録例）Live 12 Beta | 2026-06-28 | 1 | Bass | カタログから除外（コミット 108806a） |

## 失敗項目の運用

1. `failedNames` に挙がったデバイスは、Live のブラウザ表示名と挿入名が不一致か、当該エディションに存在しない。
2. Live のブラウザで実表示名を確認し、`BUILT_IN_DEVICE_CATALOG` の名称を修正する。修正で解決しない場合は当該項目をカタログから除外する。
3. `insert_device` は未掲載・失敗名に対し `validDeviceNames` ヒント付きでグレースフルに失敗するため、除外しても挿入自体は試行できる。

SDK に Browser（列挙）API が追加された場合、本検証はカタログ自動生成に置き換える。
