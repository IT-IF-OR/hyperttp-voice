import { HyperClient, type HyperClientOptions } from "hyperttp";
import { createWebRtcProtocol, type WebRtcServerHandler } from "@hyperttp/protocol-webrtc";
import { WebRtcTransport, type WebRtcTransportOptions } from "@hyperttp/transport-webrtc";
import {
  createPcmAudioSource,
  type PcmAudioOptions,
  type PcmAudioSource,
  type PcmAudioSubscription,
} from "@hyperttp/transport-webrtc/pcm-audio";

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
export async function createWebRtcAudio(
  input: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>,
  options: WebRtcAudioOptions = {},
): Promise<WebRtcAudio> {
  const source = await createPcmAudioSource(input, options);
  const subscriptions = new Set<PcmAudioSubscription>();
  const serverSubscriptions = new Map<string, PcmAudioSubscription>();
  let core: HyperClient | undefined;
  let transport: WebRtcTransport | undefined;

  try {
    const client = source.subscribe();
    subscriptions.add(client);
    transport = new WebRtcTransport({
      ...options.transport,
      localStream: (sessionId) => {
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
        // Explicit protocol only for a custom receiver; otherwise use auto-discovery.
        ...(options.handler
          ? { protocols: [createWebRtcProtocol({ handler: options.handler })] }
          : {}),
      },
      transport,
    );

    const ownedCore = core;
    let closePromise: Promise<void> | undefined;
    const close = (): Promise<void> => {
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
    return { client: core, core, transport, source, stream: client.stream, done, close };
  } catch (error: unknown) {
    await Promise.allSettled([source.close(), core ? core.destroy() : transport?.close()]);
    for (const subscription of subscriptions) subscription.close();
    throw error;
  }
}
