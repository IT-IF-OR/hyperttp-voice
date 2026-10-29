import { describe, expect, it, vi } from "vitest";
import {
  createDiscordJsVoiceAdapter,
  type DiscordGatewayAdapterCreator,
} from "../src/discordjs.js";

function fixture(send = true) {
  let callbacks: Parameters<DiscordGatewayAdapterCreator>[0] | undefined;
  const destroy = vi.fn();
  const sendPayload = vi.fn(() => send);
  const creator = vi.fn<DiscordGatewayAdapterCreator>((methods) => {
    callbacks = methods;
    return { destroy, sendPayload };
  });
  const voice = createDiscordJsVoiceAdapter({
    guildId: "1",
    channelId: "2",
    userId: "3",
    adapterCreator: creator,
    timeoutMs: 100,
  });
  return { voice, creator, destroy, sendPayload, callbacks: () => callbacks! };
}

describe("discord.js Gateway adapter bridge", () => {
  it("joins using the creator and leaves before destroying it; can reconnect", async () => {
    const f = fixture();
    const pending = f.voice.connect();
    const rejected = expect(pending).rejects.toThrow("disconnected");
    expect(f.sendPayload).toHaveBeenCalledWith({
      op: 4,
      d: {
        guild_id: "1",
        channel_id: "2",
        self_mute: false,
        self_deaf: true,
      },
    });
    f.voice.disconnect();
    await rejected;
    expect(f.sendPayload.mock.calls.length).toBe(2);
    expect(f.destroy).toHaveBeenCalledTimes(1);
    const oldCallbacks = f.callbacks();
    const again = f.voice.connect();
    const stopped = expect(again).rejects.toThrow("disconnected");
    oldCallbacks.destroy();
    oldCallbacks.onVoiceServerUpdate({ guild_id: "1", token: "old", endpoint: "invalid" });
    expect(f.voice.state).toBe("connecting");
    f.voice.destroy();
    await stopped;
    expect(f.creator).toHaveBeenCalledTimes(2);
    expect(f.destroy).toHaveBeenCalledTimes(2);
  });
  it("rejects failed sends and frees the external adapter", async () => {
    const f = fixture(false);
    await expect(f.voice.connect()).rejects.toThrow("rejected voice state");
    expect(f.destroy).toHaveBeenCalledTimes(1);
    f.voice.destroy();
  });
  it("handles Gateway destruction while joining", async () => {
    const f = fixture();
    const pending = f.voice.connect();
    const rejected = expect(pending).rejects.toThrow("disconnected");
    f.callbacks().destroy();
    await rejected;
    expect(f.voice.state).toBe("disconnected");
    expect(f.destroy).toHaveBeenCalledTimes(1);
    f.voice.destroy();
  });
  it("cleans the creator on abort and ignores late dispatches", async () => {
    const f = fixture();
    const controller = new AbortController();
    const pending = f.voice.connect(controller.signal);
    const rejected = expect(pending).rejects.toThrow("cancelled");
    controller.abort(new Error("cancelled"));
    await rejected;
    f.callbacks().onVoiceServerUpdate({ guild_id: "1", token: "secret", endpoint: "invalid" });
    expect(f.voice.state).toBe("disconnected");
    expect(f.destroy).toHaveBeenCalledTimes(1);
    f.voice.destroy();
  });
  it("rejects synchronous destruction during adapter creation", async () => {
    const destroy = vi.fn();
    const voice = createDiscordJsVoiceAdapter({
      guildId: "1",
      channelId: "2",
      userId: "3",
      adapterCreator(methods) {
        methods.destroy();
        return { destroy, sendPayload: () => true };
      },
    });
    await expect(voice.connect()).rejects.toThrow("during creation");
    expect(destroy).toHaveBeenCalledTimes(1);
    voice.destroy();
  });
});
