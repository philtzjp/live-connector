# 内蔵デバイスカタログの実機整合

`do` CREATE Device の内蔵デバイスカタログ（`apps/extension/src/tools/do/devices.ts` の `CATALOG_DEVICE_NAMES`）は手動管理の定数である。SDK v1.0.0-beta.1 に Browser（デバイス列挙）API が無いため、実機でのロード可否と自動同期しない。Live のバージョン・エディション差で乖離が生じ得る。

## 検証手段

v3.0.0 で `verify_device_catalog` ツールは**廃止**された。実機検証は以下のいずれかで行う。

- 手動: Live のブラウザでデバイス名を確認し、`do` write `MATCH (t:Track) CREATE (t)-[:HAS_DEVICE]->(d:Device {name:"..."})` で挿入試行
- 外部スクリプト: カタログ全項目を順に挿入・削除するスクリプトを MCP 外で実行

旧 `verify_device_catalog` は一時 MidiTrack を作成し、カタログ全項目を順に `insertDevice` で挿入試行し、各デバイスを即削除・一時トラックも削除して Set に残留しない設計だった。

## 結果の記録

検証を実行したら、以下の表に Live バージョンと失敗デバイス名を追記する。

| Live バージョン | 検証日 | failed 件数 | failedNames | 対応 |
| --- | --- | --- | --- | --- |
| （記録例）Live 12 Beta | 2026-06-28 | 1 | Bass | カタログから除外（コミット 108806a） |

## 失敗項目の運用

1. 挿入に失敗したデバイスは、Live のブラウザ表示名と挿入名が不一致か、当該エディションに存在しない。
2. Live のブラウザで実表示名を確認し、`CATALOG_DEVICE_NAMES` の名称を修正する。修正で解決しない場合は当該項目をカタログから除外する。
3. `do` CREATE Device は未掲載・失敗名に対し `validDeviceNames` ヒント付きでグレースフルに失敗するため、除外しても挿入自体は試行できる。

SDK に Browser（列挙）API が追加された場合、本検証はカタログ自動生成に置き換える。
