import {
  HyperClient,
  type HyperClientOptions,
  type HyperServer,
  type ServerOptions,
} from "hyperttp";
import {
  createWebRtcProtocol,
  webRtcControlHandler,
  type WebRtcServerHandler,
} from "@hyperttp/protocol-webrtc";
import {
  createWebRtcRestSignalingHandler,
  WebRtcTransport,
  type WebRtcRestSignalingRequest,
  type WebRtcSignalingHandler,
  type WebRtcTransportOptions,
} from "@hyperttp/transport-webrtc";
import type { TransportListenOptions } from "@hyperttp/types";
import {
  createPcmAudioSource,
  type PcmAudioOptions,
  type PcmAudioSource,
  type PcmAudioSubscription,
} from "@hyperttp/transport-webrtc/pcm-audio";

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
export async function createWebRtcAudio(
  input: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>,
  options: WebRtcAudioOptions = {},
): Promise<WebRtcAudio> {
  const source = await createPcmAudioSource(input, options);
  const subscriptions = new Set<PcmAudioSubscription>();
  const serverSubscriptions = new Map<string, PcmAudioSubscription>();
  let core: HyperClient | undefined;
  let transport: WebRtcTransport | undefined;
  let clientSubscription: PcmAudioSubscription | undefined;
  let clientStream: PcmAudioSubscription["stream"] | undefined;
  let closed = false;

  const getClientSubscription = (): PcmAudioSubscription => {
    if (clientSubscription) return clientSubscription;
    const subscription = source.subscribe();
    clientSubscription = subscription;
    clientStream = subscription.stream;
    subscriptions.add(subscription);
    return subscription;
  };

  try {
    transport = new WebRtcTransport({
      ...options.transport,
      localStream: (sessionId) => {
        const existing = serverSubscriptions.get(sessionId);
        if (existing) return existing.stream;
        const subscription = source.subscribe();
        subscriptions.add(subscription);
        serverSubscriptions.set(sessionId, subscription);
        return subscription.stream;
      },
      disposeLocalStream: (sessionId) => {
        const subscription = serverSubscriptions.get(sessionId);
        if (subscription) {
          subscription.close();
          subscriptions.delete(subscription);
          serverSubscriptions.delete(sessionId);
        }
      },
    });
    core = new HyperClient(
      {
        ...options.client,
        protocols: [createWebRtcProtocol({ handler: options.handler ?? webRtcControlHandler })],
      },
      transport,
    );

    const ownedCore = core;
    let closePromise: Promise<void> | undefined;
    const close = (): Promise<void> => {
      closed = true;
      closePromise ??= (async () => {
        try {
          // Stop input/FFmpeg immediately, even while peer shutdown is pending.
          const results = await Promise.allSettled([source.close(), ownedCore.destroy()]);
          const errors = results.flatMap((result) =>
            result.status === "rejected" ? [result.reason as unknown] : [],
          );
          if (errors.length) throw new AggregateError(errors, "WebRTC audio cleanup failed");
        } finally {
          for (const subscription of subscriptions) subscription.close();
          if (clientSubscription) clientStream = clientSubscription.stream;
          clientSubscription = undefined;
          subscriptions.clear();
          serverSubscriptions.clear();
        }
      })();
      return closePromise;
    };
    const done = source.done.then(
      () => close(),
      async (error: unknown) => {
        try {
          await close();
        } catch (cleanupError: unknown) {
          throw new AggregateError([error, cleanupError], "WebRTC audio source and cleanup failed");
        }
        throw error;
      },
    );
    // Callers may manage lifetime with close() without observing natural EOF.
    void done.catch(() => {});
    return {
      client: core,
      core,
      transport,
      source,
      get diagnostics(): WebRtcAudioDiagnostics {
        return {
          subscriptions: subscriptions.size,
          serverSubscriptions: serverSubscriptions.size,
          clientSubscribed: clientSubscription !== undefined,
        };
      },
      get stream(): PcmAudioSubscription["stream"] {
        if (clientStream) return clientStream;
        if (closed) throw new Error("WebRTC audio is closed");
        return getClientSubscription().stream;
      },
      done,
      createRestSignaling: (signalingOptions: TransportListenOptions): WebRtcAudioRestSignaling => {
        const signaling = transport!.createSignalingHandler(signalingOptions);
        return { signaling, route: createWebRtcRestSignalingHandler(signaling) };
      },
      close,
      server: <S = Record<never, never>>(serverOptions: ServerOptions<S>) =>
        ownedCore.server(serverOptions),
    };
  } catch (error: unknown) {
    closed = true;
    await Promise.allSettled([source.close(), core ? core.destroy() : transport?.close()]);
    for (const subscription of subscriptions) subscription.close();
    if (clientSubscription) clientStream = clientSubscription.stream;
    clientSubscription = undefined;
    subscriptions.clear();
    serverSubscriptions.clear();
    throw error;
  }
}
