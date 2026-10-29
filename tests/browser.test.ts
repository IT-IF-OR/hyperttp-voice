import { build } from "esbuild";
import { describe, expect, it, vi } from "vitest";
import { createBrowserWebRtcAudio, WebRtcTransport } from "../src/browser.js";

describe("browser entry point", () => {
  it("creates the real browser transport without requiring browser globals before use", async () => {
    const audio = createBrowserWebRtcAudio({ iceServers: [] });
    expect(audio.transport).toBeInstanceOf(WebRtcTransport);
    const destroy = vi.spyOn(audio.transport, "close");
    const first = audio.close();
    expect(audio.close()).toBe(first);
    await first;
    expect(destroy).toHaveBeenCalledTimes(1);
    await expect(
      audio.transport.execute({
        url: "webrtc://localhost",
        method: "GET",
        headers: {},
      }),
    ).rejects.toThrow("closed");
  });

  it("bundles for the browser without Node, Werift, FFmpeg or native codec dependencies", async () => {
    const result = await build({
      entryPoints: ["src/browser.ts"],
      platform: "browser",
      format: "esm",
      bundle: true,
      write: false,
      metafile: true,
    });
    expect(result.outputFiles[0]?.text.length).toBeGreaterThan(0);
    for (const input of Object.keys(result.metafile!.inputs)) {
      expect(input).not.toMatch(
        /werift|libopus-node|@snazzah|pcm-audio|src\/(?:discord|runtime|codec|rtp)\.ts/,
      );
    }
  });
});
