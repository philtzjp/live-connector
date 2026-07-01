/**
 * `@ableton-extensions/sdk` の実体（Live 実機依存）をロードせずに、instanceof 判定と
 * クラス継承関係だけを再現するフェイク。テストで `vi.mock("@ableton-extensions/sdk", ...)`
 * のファクトリからこのモジュールを返して使う。
 *
 * 継承関係は SDK typedoc に合わせる:
 *   Track ← MidiTrack / AudioTrack / ReturnTrack / MainTrack
 *   Clip ← MidiClip / AudioClip
 *   Device ← RackDevice ← DrumRack, Device ← Simpler
 *   Chain ← DrumChain
 */

export class Song {}
export class Track {}
export class MidiTrack extends Track {}
export class AudioTrack extends Track {}
export class ReturnTrack extends Track {}
export class MainTrack extends Track {}
export class TrackMixer {}
export class Clip {}
export class MidiClip extends Clip {}
export class AudioClip extends Clip {}
export class ClipSlot {}
export class Scene {}
export class Device {}
export class RackDevice extends Device {}
export class DrumRack extends RackDevice {}
export class Simpler extends Device {}
export class DeviceParameter {}
export class Chain {}
export class DrumChain extends Chain {}
export class CuePoint {}
export class TakeLane {}

export const WarpMode = {
    Beats: 0,
    Tones: 1,
    Texture: 2,
    Repitch: 3,
    Complex: 4,
    ComplexPro: 5,
} as const

export const GridQuantization = {
    NoGrid: 0,
    EightBars: 1,
    FourBars: 2,
    TwoBars: 3,
    Bar: 4,
    Half: 5,
    Quarter: 6,
    Eighth: 7,
    Sixteenth: 8,
    ThirtySecond: 9,
} as const
