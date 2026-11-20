import { HyperClient, type HyperClientOptions, type HyperServer, type ServerOptions } from "hyperttp";
import { type WebRtcServerHandler } from "@hyperttp/protocol-webrtc";
import { WebRtcTransport, type WebRtcRestSignalingRequest, type WebRtcSignalingHandler, type WebRtcTransportOptions } from "@hyperttp/transport-webrtc";
import type { TransportListenOptions } from "@hyperttp/types";
import { type PcmAudioOptions, type PcmAudioSource, type PcmAudioSubscription } from "@hyperttp/transport-webrtc/pcm-audio";
export interface WebRtcAudioOptions extends PcmAudioOptions {
    /** Media ownership is managed by this adapter, not by transport overrides. */
    transport?: Omit<WebRtcTransportOptions, "localStream" | "disposeLocalStream">;
    /** Overrides the default connect/stream ACK; other actions default to 501. */
    handler?: WebRtcServerHandler;
    /** Client plugins/configuration; PCM transport ownership stays with this adapter. */
    client?: Omit<HyperClientOptions, "customTransport" | "protocols" | "receivers">;
}
export interface WebRtcAudioRestSignaling {
    /** Must be closed on application shutdown if it outlives audio.close(). */
    readonly signaling: WebRtcSignalingHandler;
    /** Register this route for POST, GET, PATCH and DELETE on an existing HyperServer. */
    readonly route: (request: WebRtcRestSignalingRequest) => Promise<{
        status: number;
        headers: Record<string, string>;
        body?: unknown;
    }>;
}
export interface WebRtcAudioDiagnostics {
    /** Active PCM subscriptions owned by this adapter. */
    readonly subscriptions: number;
    /** Active server-session PCM subscriptions. */
    readonly serverSubscriptions: number;
    /** Whether the client-side stream currently owns a PCM subscription. */
    readonly clientSubscribed: boolean;
}
export interface WebRtcAudio {
    readonly client: HyperClient;
    /** @deprecated Use client. Kept as a migration alias. */
    readonly core: HyperClient;
    readonly transport: WebRtcTransport;
    readonly source: PcmAudioSource;
    readonly diagnostics: WebRtcAudioDiagnostics;
    /** Pass to client.webrtc.stream(peerUrl, stream) for client-side sending. */
    readonly stream: PcmAudioSubscription["stream"];
    /** Resolves after EOF/close and cleanup; rejects on PCM/encoder failure. */
    readonly done: Promise<void>;
    /**
     * Creates REST signaling for an existing HyperServer without opening a listener.
     * Register route for POST, GET, PATCH and DELETE; close signaling during shutdown.
     */
    createRestSignaling(options: TransportListenOptions): WebRtcAudioRestSignaling;
    /** Configures a DI-enabled server; caller registers signaling and starts it explicitly. */
    server<S = Record<never, never>>(options: ServerOptions<S>): HyperServer<S>;
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