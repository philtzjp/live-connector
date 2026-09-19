/**
 * Runtime の排他制御。Main 録音中は Set 変更・undo・他の render 開始・
 * transport.play/seek を拒否し、読み取り・job 照会・その job の cancel は許可する。
 */

import { HybridError } from "@live-connector/error"

/** 録音ジョブ単位の排他ロック。 */
export class RuntimeLocks {
    private recording_owner: string | null = null

    /** Main 録音を開始する。既に録音中なら RENDER_BUSY。 */
    acquireRecording(job_id: string): void {
        if (this.recording_owner !== null) {
            throw new HybridError(
                "RENDER_BUSY",
                `Render job "${this.recording_owner}" is currently recording; only cancel and reads are allowed`,
            )
        }
        this.recording_owner = job_id
    }

    /** 録音の所有者だけがロックを解放できる。 */
    releaseRecording(job_id: string): void {
        if (this.recording_owner === job_id) {
            this.recording_owner = null
        }
    }

    recordingOwner(): string | null {
        return this.recording_owner
    }

    isRecording(): boolean {
        return this.recording_owner !== null
    }

    /** Set を変更する操作の事前検査。録音中は拒否する。 */
    assertWritable(): void {
        if (this.recording_owner !== null) {
            throw new HybridError(
                "RENDER_BUSY",
                `Render job "${this.recording_owner}" is recording; writes and undo are rejected until it finishes or is cancelled`,
            )
        }
    }

    /** Transport を変更する操作の事前検査。録音中は該当ジョブの cancel へ案内する。 */
    assertTransportFree(operation: string): void {
        if (this.recording_owner !== null) {
            throw new HybridError(
                "TRANSPORT_BUSY",
                `${operation} is not allowed while render job "${this.recording_owner}" is recording`,
                409,
                {
                    hint: `Cancel the recording with CALL render.cancel("${this.recording_owner}") instead of stopping the Transport directly.`,
                },
            )
        }
    }
}
