import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { expect, it, vi } from "vitest";
import { WebRtcTransport } from "@hyperttp/transport-webrtc";
import { createWebRtcAudio } from "../src/webrtc.js";

const probe = spawnSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" });
const hasOpus = probe.status === 0 && /\blibopus\b/.test(probe.stdout);

it.skipIf(!hasOpus)(
  "voice adapter delivers Opus over a real trickle ICE session",
  async () => {
    const socket = createServer();
    await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
    const address = socket.address();
    if (!address || typeof address === "string") throw new Error("No port available");
    await new Promise<void>((resolve, reject) =>
      socket.close((error) => (error ? reject(error) : resolve())),
    );
    const pcm = new Uint8Array(960 * 4);
    const input = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(pcm);
      },
    });
    const audio = await createWebRtcAudio(input, { transport: { iceServers: [] } });
    const client = new WebRtcTransport({ iceServers: [], trickleIce: true });
    let packets = 0;
    const methods: string[] = [];
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
      methods.push(init?.method ?? "GET");
      return originalFetch(url, init);
    });
    const untrack = client.onTrack(({ track }) => {
      track.onReceiveRtp.subscribe(() => {
        packets++;
      });
    });
    try {
      await audio.transport.listen({
        host: "127.0.0.1",
        port: address.port,
        onRequest: () => ({ status: 200, headers: {}, body: "ok" }),
      });
      const request = {
        protocol: "webrtc" as const,
        method: "POST",
        headers: {},
        url: `webrtc://127.0.0.1:${address.port}/signal`,
        receiveAudio: true,
      };
      const response = await client.execute(request);
      expect(response.body).toBe("ok");
      await expect.poll(() => packets, { timeout: 5000 }).toBeGreaterThan(0);
      expect(methods).toEqual(expect.arrayContaining(["POST", "PATCH", "GET"]));
    } finally {
      fetchSpy.mockRestore();
      untrack();
      await client.close();
      await audio.close();
    }
  },
  20000,
);
