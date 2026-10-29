import { HyperClient, type HyperClientOptions } from "hyperttp";
import { type WebRtcServerHandler } from "@hyperttp/protocol-webrtc";
import { WebRtcTransport, type WebRtcTransportOptions } from "@hyperttp/transport-webrtc";
import { type PcmAudioOptions, type PcmAudioSource, type PcmAudioSubscription } from "@hyperttp/transport-webrtc/pcm-audio";
export interface WebRtcAudioOptions extends PcmAudioOptions {
    /** Media ownership is managed by this adapter, not by transport overrides. */
    transport?: Omit<WebRtcTransportOptions, "localStream" | "disposeLocalStream">;
    handler?: WebRtcServerHandler;
    /** Client plugins/configuration; PCM transport ownership stays with this adapter. */
    client?: Omit<HyperClientOptions, "customTransport" | "protocols" | "receivers">;
}
export interface WebRtcAudio {
    readonly client: HyperClient;
    /** @deprecated Use client. Kept as a migration alias. */
    readonly core: HyperClient;
    readonly transport: WebRtcTransport;
    readonly source: PcmAudioSource;
    /** Pass to client.webrtc.stream(peerUrl, stream) for client-side sending. */
    readonly stream: PcmAudioSubscription["stream"];
    /** Resolves after EOF/close and cleanup; rejects on PCM/encoder failure. */
    readonly done: Promise<void>;
    close(): Promise<void>;
}
/**
 * Server-side, live PCM bridge: raw 48 kHz stereo signed 16-bit little-endian.
 * Requires FFmpeg with libopus. Encoding and pacing belong solely to the PCM
 * source; this adapter forwards its Werift streams without another encoder.
 * Server sessions get independent subscriptions to the same live source (no
 * replay). EOF, input failure, or options.signal abort closes the whole adapter.
 * Use close() to release resources while input is still pending. Producers must
 * cooperate with iterator.return()/reader.cancel() to release their own work.
 */
export declare function createWebRtcAudio(input: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>, options?: WebRtcAudioOptions): Promise<WebRtcAudio>;
//# sourceMappingURL=webrtc.d.ts.map