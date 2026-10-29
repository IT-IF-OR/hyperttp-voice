import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { HyperClient } from "hyperttp";
import { createWebRtcProtocol } from "@hyperttp/protocol-webrtc";
import { WebRtcTransport } from "@hyperttp/transport-webrtc";
import { createPcmAudioSource } from "@hyperttp/transport-webrtc/pcm-audio";
import { createWebRtcAudio } from "../src/webrtc.js";

const encoderProbe = spawnSync("ffmpeg", ["-hide_banner", "-encoders"], {
  encoding: "utf8",
  timeout: 5_000,
});
const hasFfmpeg = encoderProbe.status === 0 && /\blibopus\b/.test(encoderProbe.stdout);
const pcmTest = it.skipIf(!hasFfmpeg);

function pendingInput() {
  let cancelled = false;
  const input = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  return {
    input,
    get cancelled() {
      return cancelled;
    },
  };
}

async function* silence() {
  // One second of PCM, deliberately split across stereo sample boundaries.
  const pcm = new Uint8Array(48_000 * 2 * 2);
  yield pcm.subarray(0, 3);
  yield pcm.subarray(3, 16_385);
  yield pcm.subarray(16_385);
}

describe("installed WebRTC APIs", () => {
  it("auto-loads WebRTC sender through HyperClient without manual protocol registration", async () => {
    const requests: string[] = [];
    const client = new HyperClient(
      { builtInPlugins: false },
      {
        async execute(request) {
          requests.push(request.protocol ?? "");
          return { status: 200, statusText: "OK", headers: {}, body: { connected: true } };
        },
      },
    );
    try {
      expect(typeof client.webrtc.connect).toBe("function");
      await client.webrtc.connect("http://127.0.0.1/signal");
      expect(requests).toEqual(["webrtc"]);
    } finally {
      await client.destroy();
    }
  });
  it("exports the real PCM bridge and protocol", () => {
    expect(createPcmAudioSource).toBeTypeOf("function");
    const protocol = createWebRtcProtocol();
    expect(protocol.protocol).toBe("webrtc");
    expect(protocol.sender).toBeDefined();
    expect(protocol.receiver).toBeDefined();
    expect(WebRtcTransport).toBeTypeOf("function");
  });

  it("rejects an already aborted signal before consuming input", async () => {
    const pending = pendingInput();
    const reason = new Error("already aborted");
    await expect(
      createWebRtcAudio(pending.input, {
        signal: AbortSignal.abort(reason),
      }),
    ).rejects.toBe(reason);
    expect(pending.input.locked).toBe(false);
    await pending.input.cancel();
  });

  it("propagates executable startup failures", async () => {
    const pending = pendingInput();
    try {
      await expect(
        createWebRtcAudio(pending.input, {
          ffmpegPath: "/nonexistent-hyperttp-voice-ffmpeg",
        }),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(pending.input.locked).toBe(false);
    } finally {
      await pending.input.cancel();
    }
  });
});

describe("real FFmpeg PCM integration (requires libopus)", () => {
  pcmTest(
    "forwards PCM through the actual bridge to independent RTP tracks",
    async () => {
      const source = await createPcmAudioSource(silence());
      const first = source.subscribe();
      const second = source.subscribe();
      const firstTrack = first.stream.getAudioTracks()[0]!;
      const secondTrack = second.stream.getAudioTracks()[0]!;
      const firstPackets: number[] = [];
      const secondPackets: number[] = [];
      firstTrack.onReceiveRtp.subscribe((packet) => {
        expect(packet.header.payloadType).toBe(111);
        expect(packet.payload.byteLength).toBeGreaterThan(0);
        firstPackets.push(packet.header.sequenceNumber);
      });
      secondTrack.onReceiveRtp.subscribe((packet) => {
        secondPackets.push(packet.header.sequenceNumber);
      });
      try {
        expect(firstTrack).not.toBe(secondTrack);
        await source.done;
        expect(firstPackets.length).toBeGreaterThan(0);
        expect(secondPackets).toEqual(firstPackets);
        expect(firstTrack.stopped).toBe(true);
        expect(secondTrack.stopped).toBe(true);
      } finally {
        first.close();
        second.close();
        await source.close();
      }
    },
    15_000,
  );

  pcmTest(
    "exposes a configured core and client stream, then cleans up on EOF",
    async () => {
      const audio = await createWebRtcAudio(silence(), {
        transport: { iceServers: [] },
        handler: () => ({ payload: "ok" }),
      });
      let packets = 0;
      const track = audio.stream.getAudioTracks()[0]!;
      track.onReceiveRtp.subscribe(() => {
        packets++;
      });
      try {
        expect(audio.client).toBeInstanceOf(HyperClient);
        expect(audio.core).toBe(audio.client);
        expect(audio.transport).toBeInstanceOf(WebRtcTransport);
        expect(await audio.client.getProtocolName("webrtc")).toBe("WebRtcProtocol");
        expect(audio.core.webrtc.stream).toBeTypeOf("function");
        expect(await audio.core.getTransportName()).toBe("WebRtcTransport");
        await audio.done;
        expect(packets).toBeGreaterThan(0);
        expect(track.stopped).toBe(true);
        await expect(
          audio.transport.execute({
            protocol: "webrtc",
            url: "http://127.0.0.1",
            method: "POST",
            headers: {},
          }),
        ).rejects.toThrow(/closed/i);
      } finally {
        await audio.close();
      }
    },
    15_000,
  );

  pcmTest("close is idempotent and cancels a pending ReadableStream", async () => {
    const pending = pendingInput();
    const audio = await createWebRtcAudio(pending.input);
    try {
      const closing = audio.close();
      expect(audio.close()).toBe(closing);
      await closing;
      await audio.done;
      expect(pending.cancelled).toBe(true);
      expect(pending.input.locked).toBe(false);
      expect(audio.stream.getTracks().every((track) => track.stopped)).toBe(true);
    } finally {
      await audio.close();
    }
  });

  pcmTest("close requests return on a pending async iterator", async () => {
    let returned = false;
    const input: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<Uint8Array>>(() => {}),
          return: async () => {
            returned = true;
            return { done: true, value: undefined };
          },
        };
      },
    };
    const audio = await createWebRtcAudio(input);
    try {
      await audio.close();
      await audio.done;
      expect(returned).toBe(true);
    } finally {
      await audio.close();
    }
  });

  pcmTest("preserves input errors through done and releases the reader", async () => {
    const reason = new Error("PCM producer failed");
    const input = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(reason);
      },
    });
    const audio = await createWebRtcAudio(input);
    try {
      await expect(audio.done).rejects.toBe(reason);
      expect(input.locked).toBe(false);
      expect(audio.stream.getTracks().every((track) => track.stopped)).toBe(true);
    } finally {
      await audio.close();
    }
  });

  pcmTest("rejects an incomplete final stereo sample", async () => {
    async function* malformed() {
      yield new Uint8Array(3);
    }
    const audio = await createWebRtcAudio(malformed());
    try {
      await expect(audio.done).rejects.toThrow(/incomplete stereo s16le sample/);
    } finally {
      await audio.close();
    }
  });

  pcmTest("abort rejects done and cleans up the whole adapter", async () => {
    const controller = new AbortController();
    const pending = pendingInput();
    const audio = await createWebRtcAudio(pending.input, { signal: controller.signal });
    const reason = new Error("stop audio");
    try {
      controller.abort(reason);
      await expect(audio.done).rejects.toBe(reason);
      expect(pending.cancelled).toBe(true);
      expect(pending.input.locked).toBe(false);
      expect(audio.stream.getTracks().every((track) => track.stopped)).toBe(true);
    } finally {
      await audio.close();
    }
  });
});
