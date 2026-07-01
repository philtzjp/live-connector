# MIDI 楽器トラックの試聴・検証

## SDK の能力境界

Ableton Extensions SDK v1.0.0-beta.0 の API サーフェス調査（全 28 クラスのメンバー列挙・api 全体 grep, 2026-06-27）に基づく。

- レンダリング手段は `Resources.renderPreFxAudio(track: AudioTrack, startTime, endTime): Promise<string>` のみ。対象は **AudioTrack 限定**で、アレンジメント上のオーディオクリップの **pre-FX 音声**をレンダリングする。
- **存在しない**: transport（再生 / 録音 / 再生位置）、トラック入出力ルーティング、モニタリング、freeze / flatten / resample / bounce。
- 帰結: **SDK 経由で MIDI 楽器トラックの合成出力（インストゥルメントの実音）を audio 化する手段は無い**。`renderPreFxAudio` は MIDI トラックを受け付けず、MIDI 楽器の合成出力も対象外。

## 実音の検証経路（手動 resample が前提）

エージェントが生成する楽器は MIDI トラックに載るため、その実音を検証するには、ユーザーが Live 上で MIDI トラックを AudioTrack へ印刷する手動操作が必要である。

1. ユーザーが Live で対象 MIDI トラックを **resample / freeze & flatten** して AudioTrack のアレンジメントクリップに印刷する（この操作は SDK 非対応のため手動）。
2. 印刷した AudioTrack に対して `render_audio`（`apps/extension/src/tools/audio.ts`）を適用し、`startTime` / `endTime`（beats）範囲で WAV を書き出す。長尺は `background:true` + `get_render_job` を使う。
3. 書き出した WAV を `fs` + `audio-decode` などで解析し、特徴量（帯域 energy / RMS / peak / onset / chroma）やスペクトログラムを得る（エージェント側スクリプトまたはサイドカー）。

## 近似の自動検証経路（本リポジトリでは範囲外）

MidiClip の `notes`（`query` で取得）を汎用シンセ（soundfont / 簡易合成）で WAV 化し、タイミング・アレンジ・和声・ノート整合を検証する近似経路は技術的には可能だが、本リポジトリの射程外とする（記録）。理由:

- 近似出力は Live の実音色・third-party plug-in（Serum 等）の出力を **反映しない**。検証できるのはタイミング / アレンジ / 和声 / ノート整合に限られ、実音の確認にはならない。
- soundfont / 合成エンジンの同梱と、Extension Host の vm ランタイム（[[extension-host-runtime]] の制約）での DSP 実行は実装コストが大きい。
- 実装する場合は `render_audio` のジョブ方式（#55 / `get_render_job`）と同じ応答方式を共有できる。採用時は別 Issue に分割する。

## 真の解決（upstream）

MIDI トラックの実音検証は、upstream（Ableton Extensions SDK）への **MIDI トラック render / freeze / resample API 追加**が前提である。追加され次第、手動 resample 前提を置き換える。本リポジトリの射程外として記録する。

関連: #21（AudioTrack のレンダリング・解析）、#55（render_audio のジョブ方式）、#13 / #14 / #15（生成系）。
