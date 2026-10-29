import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createSocket } from "node:dgram";
import type { Duplex } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscordVoiceAdapter, type GatewayDispatch, type VoiceGateway } from "../src/discord.js";
import { createVoiceRuntime } from "../src/runtime.js";
import { OPUS_SILENCE } from "../src/rtp.js";
import { decryptRtp, DISCORD_ENCRYPTION_MODE } from "../src/rtp.js";

const dave = vi.hoisted(() => ({
  json: vi.fn(),
  binary: vi.fn(),
  encrypt: vi.fn((packet: Buffer) => packet),
  destroy: vi.fn(),
  pending: false,
  instances: [] as Array<{ ready: boolean; wake: () => void }>,
}));
vi.mock("../src/dave.js", () => ({
  DaveAdapter: class {
    maxProtocolVersion = 1;
    version = 0;
    ready = !dave.pending;
    listeners = new Set<() => void>();
    wake() {
      this.ready = true;
      for (const listener of this.listeners) listener();
    }
    waitUntilReady(signal?: AbortSignal) {
      if (this.ready) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const finish = () => {
          this.listeners.delete(finish);
          signal?.removeEventListener("abort", abort);
          resolve();
        };
        const abort = () => {
          this.listeners.delete(finish);
          signal?.removeEventListener("abort", abort);
          reject(signal?.reason);
        };
        this.listeners.add(finish);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      });
    }
    constructor(
      _user: string,
      _channel: string,
      readonly sendJson: (op: number, d: unknown) => void,
      readonly sendBinary: (op: number, d: Buffer) => void,
      readonly options: { requireDave?: boolean },
    ) {
      dave.instances.push(this);
    }
    configure(version: number) {
      this.version = version;
      if (this.options.requireDave && !version) throw new Error("DAVE required");
    }
    handleJson(op: number, data: unknown) {
      dave.json(op, data);
      if (op === 24) this.sendBinary(26, Buffer.from([9]));
      return true;
    }
    handleBinary(op: number, data: Buffer) {
      dave.binary(op, data);
      return true;
    }
    encrypt(packet: Buffer) {
      return dave.encrypt(packet);
    }
    destroy() {
      dave.destroy();
    }
  },
}));

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.clearAllMocks();
  dave.pending = false;
  dave.instances.length = 0;
});
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2500;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Test condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Minimal RFC6455 test peer: exercises the real built-in WebSocket, no ws dependency. */
async function fixture(
  options: {
    modes?: string[];
    ack?: boolean;
    sessionVersion?: number;
    noHello?: boolean;
    noDiscovery?: boolean;
  } = {},
) {
  const udp = createSocket("udp4");
  await new Promise<void>((resolve) => udp.bind(0, "127.0.0.1", resolve));
  const udpPort = udp.address().port;
  const packets: Buffer[] = [];
  udp.on("message", (packet, remote) => {
    if (packet.length === 74 && packet.readUInt16BE(0) === 1) {
      if (options.noDiscovery) return;
      const reply = Buffer.from(packet);
      reply.writeUInt16BE(2);
      reply.write("127.0.0.1", 8);
      reply.writeUInt16BE(remote.port, 72);
      udp.send(reply, remote.port, remote.address);
    } else packets.push(packet);
  });
  const messages: Array<{ op: number; d: Record<string, unknown> }> = [];
  const binary: Buffer[] = [];
  const sockets = new Set<Duplex>();
  let socket: Duplex | undefined;
  const server = createServer();
  function frame(payload: Buffer, opcode: number) {
    const header = Buffer.alloc(payload.length < 126 ? 2 : 4);
    header[0] = 0x80 | opcode;
    if (payload.length < 126) header[1] = payload.length;
    else {
      header[1] = 126;
      header.writeUInt16BE(payload.length, 2);
    }
    socket!.write(Buffer.concat([header, payload]));
  }
  const send = (op: number, d: unknown, seq?: number) =>
    frame(Buffer.from(JSON.stringify({ op, d, ...(seq === undefined ? {} : { seq }) })), 1);
  server.on("upgrade", (req, peer) => {
    sockets.add(peer);
    socket = peer;
    const accept = createHash("sha1")
      .update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    peer.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    let input = Buffer.alloc(0);
    peer.on("data", (chunk: Buffer) => {
      input = Buffer.concat([input, chunk]);
      while (input.length >= 2) {
        const opcode = input[0]! & 15;
        let size = input[1]! & 127;
        let offset = 2;
        if (size === 126) {
          if (input.length < 4) return;
          size = input.readUInt16BE(2);
          offset = 4;
        }
        if (size === 127) throw new Error("Unexpected large test frame");
        const masked = !!(input[1]! & 128);
        if (input.length < offset + (masked ? 4 : 0) + size) return;
        const mask = input.subarray(offset, offset + 4);
        if (masked) offset += 4;
        const payload = Buffer.from(input.subarray(offset, offset + size));
        if (masked) for (let i = 0; i < size; i++) payload[i]! ^= mask[i % 4]!;
        input = input.subarray(offset + size);
        if (opcode === 8) {
          peer.end(Buffer.from([0x88, 0]));
          return;
        }
        if (opcode === 2) {
          binary.push(payload);
          continue;
        }
        if (opcode !== 1) continue;
        const message = JSON.parse(payload.toString()) as {
          op: number;
          d: Record<string, unknown>;
        };
        messages.push(message);
        if (message.op === 0 && !options.noHello) {
          send(8, { heartbeat_interval: 80 });
          send(2, {
            ip: "127.0.0.1",
            port: udpPort,
            ssrc: 1234,
            modes: options.modes ?? [DISCORD_ENCRYPTION_MODE],
          });
        } else if (message.op === 3 && options.ack !== false) send(6, { t: message.d.t });
        else if (message.op === 1)
          send(4, {
            mode: DISCORD_ENCRYPTION_MODE,
            secret_key: Array.from(Buffer.alloc(32, 42)),
            dave_protocol_version: options.sessionVersion ?? 1,
          });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test address");
  cleanups.push(async () => {
    for (const peer of sockets) peer.destroy();
    udp.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    endpoint: `ws://127.0.0.1:${address.port}`,
    messages,
    packets,
    binary,
    send,
    sendBinary(seq: number, op: number, data: Buffer) {
      const prefix = Buffer.alloc(3);
      prefix.writeUInt16BE(seq);
      prefix[2] = op;
      frame(Buffer.concat([prefix, data]), 2);
    },
    close: () => socket!.destroy(),
  };
}
function adapter(
  endpoint: string,
  extra: Partial<ConstructorParameters<typeof DiscordVoiceAdapter>[0]> = {},
) {
  const value = new DiscordVoiceAdapter({
    guildId: "guild",
    channelId: "channel",
    userId: "user",
    session: { endpoint, token: "token", sessionId: "session" },
    timeoutMs: 1000,
    ...extra,
  });
  cleanups.push(() => value.destroy());
  return value;
}
class Gateway implements VoiceGateway {
  listeners = new Set<(event: GatewayDispatch) => void>();
  sent: Array<{ op: number; d: unknown }> = [];
  send(payload: { op: number; d: unknown }) {
    this.sent.push(payload);
  }
  on(_event: "dispatch", listener: (event: GatewayDispatch) => void) {
    this.listeners.add(listener);
  }
  off(_event: "dispatch", listener: (event: GatewayDispatch) => void) {
    this.listeners.delete(listener);
  }
  dispatch(t: string, d: unknown) {
    for (const listener of this.listeners) listener({ t, d });
  }
}

describe("Discord Voice adapter on real WebSocket + UDP sockets", () => {
  it("waits for DAVE then supports immediate play and a paced five-packet silence tail", async () => {
    dave.pending = true;
    const peer = await fixture();
    const voice = adapter(peer.endpoint);
    let connected = false;
    const connection = voice.connect().then(() => {
      connected = true;
    });
    await until(() => dave.instances.length === 1 && peer.messages.some((m) => m.op === 1));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(connected).toBe(false);
    expect(voice.state).toBe("connecting");
    dave.instances[0]!.wake();
    await connection;
    const runtime = createVoiceRuntime(voice);
    cleanups.push(() => runtime.destroy());
    const start = performance.now();
    await runtime.play(
      (async function* () {
        yield OPUS_SILENCE;
      })(),
      { format: "opus", samples: 960 },
    );
    await until(
      () => peer.packets.length === 6 && peer.messages.filter((m) => m.op === 5).length === 2,
    );
    expect(performance.now() - start).toBeGreaterThanOrEqual(90);
    expect(peer.messages.filter((m) => m.op === 5).map((m) => m.d.speaking)).toEqual([1, 0]);
    for (const packet of peer.packets)
      expect(decryptRtp(packet, Buffer.alloc(32, 42)).subarray(12)).toEqual(OPUS_SILENCE);
    await voice.endTransmission();
    expect(peer.packets).toHaveLength(6);
  });
  it("holds a send through an epoch transition without dropping the connection", async () => {
    const peer = await fixture();
    const voice = adapter(peer.endpoint);
    await voice.connect();
    const session = dave.instances[0]!;
    session.ready = false;
    let sent = false;
    const send = voice.sendOpus(OPUS_SILENCE).then(() => {
      sent = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(sent).toBe(false);
    expect(peer.packets).toHaveLength(0);
    expect(voice.connected).toBe(true);
    await expect(voice.sendOpus(OPUS_SILENCE)).rejects.toThrow("Concurrent");
    session.wake();
    await send;
    await until(() => peer.packets.length === 1);
  });
  it("cancels an epoch wait on playback stop without sending a stale frame", async () => {
    const peer = await fixture();
    const voice = adapter(peer.endpoint);
    await voice.connect();
    dave.instances[0]!.ready = false;
    const runtime = createVoiceRuntime(voice);
    cleanups.push(() => runtime.destroy());
    const playback = runtime.play(
      (async function* () {
        yield OPUS_SILENCE;
      })(),
      { format: "opus", samples: 960 },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    await runtime.stop();
    await playback;
    dave.instances[0]!.wake();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(peer.packets).toHaveLength(0);
    expect(voice.connected).toBe(true);
  });
  it("rejects a pending media handshake on disconnect", async () => {
    dave.pending = true;
    const peer = await fixture();
    const voice = adapter(peer.endpoint);
    const connection = voice.connect();
    const rejected = expect(connection).rejects.toThrow("disconnected");
    await until(() => dave.instances.length === 1);
    voice.disconnect();
    await rejected;
    dave.instances[0]!.wake();
    expect(voice.state).toBe("disconnected");
  });
  it("identifies, discovers UDP, selects AES, configures DAVE, sends speaking and authenticated RTP", async () => {
    const peer = await fixture();
    const voice = adapter(peer.endpoint);
    await voice.connect();
    expect(voice.state).toBe("ready");
    expect(voice.daveVersion).toBe(1);
    expect(peer.messages[0]).toEqual({
      op: 0,
      d: {
        server_id: "guild",
        user_id: "user",
        session_id: "session",
        token: "token",
        max_dave_protocol_version: 1,
      },
    });
    expect(peer.messages.find((m) => m.op === 1)?.d).toMatchObject({
      protocol: "udp",
      data: { address: "127.0.0.1", mode: DISCORD_ENCRYPTION_MODE },
    });
    await voice.sendOpus(Buffer.from("opus"));
    await voice.sendOpus(Buffer.from("next"), 480);
    await until(() => peer.packets.length === 2 && peer.messages.some((m) => m.op === 5));
    const first = decryptRtp(peer.packets[0]!, Buffer.alloc(32, 42));
    const second = decryptRtp(peer.packets[1]!, Buffer.alloc(32, 42));
    expect(first.readUInt32BE(8)).toBe(1234);
    expect(first.subarray(12).toString()).toBe("opus");
    expect(second.readUInt16BE(2)).toBe((first.readUInt16BE(2) + 1) & 65535);
    expect(second.readUInt32BE(4)).toBe((first.readUInt32BE(4) + 960) >>> 0);
    expect(dave.encrypt).toHaveBeenCalledTimes(2);
    expect(peer.messages.filter((m) => m.op === 5)).toHaveLength(1);
  });
  it("forwards membership and binary DAVE, uses latest server sequence ACK and client opcode-only framing", async () => {
    const peer = await fixture();
    const voice = adapter(peer.endpoint);
    await voice.connect();
    peer.send(11, { user_ids: ["other"] }, 65535);
    peer.send(13, { user_id: "other" }, 0);
    peer.send(24, { epoch: 1, protocol_version: 1 });
    peer.sendBinary(1, 25, Buffer.from([7, 8]));
    await until(
      () => peer.messages.some((m) => m.op === 3 && m.d.seq_ack === 1) && peer.binary.length > 0,
    );
    expect(dave.json).toHaveBeenCalledWith(11, { user_ids: ["other"] });
    expect(dave.json).toHaveBeenCalledWith(13, { user_id: "other" });
    expect(dave.binary).toHaveBeenCalledWith(25, Buffer.from([7, 8]));
    expect(peer.binary[0]).toEqual(Buffer.from([26, 9]));
  });
  for (const reverse of [false, true])
    it(`waits for both matched Gateway events (reverse=${reverse})`, async () => {
      const peer = await fixture();
      const gateway = new Gateway();
      const voice = new DiscordVoiceAdapter({
        guildId: "guild",
        channelId: "channel",
        userId: "user",
        gateway,
      });
      cleanups.push(() => voice.destroy());
      const connection = voice.connect();
      const state = () =>
        gateway.dispatch("VOICE_STATE_UPDATE", {
          guild_id: "guild",
          user_id: "user",
          channel_id: "channel",
          session_id: "session",
        });
      const server = () =>
        gateway.dispatch("VOICE_SERVER_UPDATE", {
          guild_id: "guild",
          endpoint: peer.endpoint,
          token: "token",
        });
      gateway.dispatch("VOICE_STATE_UPDATE", {
        guild_id: "guild",
        user_id: "wrong",
        session_id: "bad",
      });
      (reverse ? server : state)();
      expect(peer.messages).toHaveLength(0);
      (reverse ? state : server)();
      await connection;
      expect(gateway.sent[0]).toMatchObject({
        op: 4,
        d: { guild_id: "guild", channel_id: "channel" },
      });
      gateway.dispatch("VOICE_SERVER_UPDATE", { guild_id: "guild", endpoint: null });
      expect(voice.state).toBe("disconnected");
      expect(gateway.listeners.size).toBe(0);
    });
  it("fails unsupported advertised modes instead of falling back", async () => {
    const peer = await fixture({ modes: ["aead_xchacha20_poly1305_rtpsize"] });
    const voice = adapter(peer.endpoint);
    const errors: Error[] = [];
    voice.on("error", (error) => errors.push(error));
    await expect(voice.connect()).rejects.toThrow(/does not advertise/);
    expect(errors).toHaveLength(1);
    expect(voice.state).toBe("disconnected");
    expect(peer.messages.some((m) => m.op === 1)).toBe(false);
  });
  it("detects missing heartbeat ACKs after becoming ready", async () => {
    const peer = await fixture({ ack: false });
    const voice = adapter(peer.endpoint);
    const errors: Error[] = [];
    voice.on("error", (error) => errors.push(error));
    await voice.connect();
    await until(() => voice.state === "disconnected");
    expect(errors[0]?.message).toMatch(/ACK timed out/);
  });
  it("times out discovery and rejects DAVE downgrade when required", async () => {
    const missing = await fixture({ noDiscovery: true });
    await expect(adapter(missing.endpoint, { timeoutMs: 100 }).connect()).rejects.toThrow(
      /timed out/,
    );
    const legacy = await fixture({ sessionVersion: 0 });
    await expect(adapter(legacy.endpoint, { requireDave: true }).connect()).rejects.toThrow(
      /DAVE required/,
    );
  });
  it("cancels pending attempts, coalesces connect calls, and reconnects explicitly without stale close races", async () => {
    const peer = await fixture();
    const voice = adapter(peer.endpoint);
    const abort = new AbortController();
    const first = voice.connect(abort.signal);
    expect(voice.connect()).toBe(first);
    abort.abort(new Error("cancelled"));
    await expect(first).rejects.toThrow("cancelled");
    await voice.connect();
    expect(voice.state).toBe("ready");
    peer.close();
    await until(() => voice.state === "disconnected");
    await voice.connect();
    expect(voice.state).toBe("ready");
    voice.disconnect();
    voice.disconnect();
    await voice.connect();
    voice.destroy();
    voice.destroy();
    await expect(voice.connect()).rejects.toThrow(/destroyed/);
    await expect(voice.sendOpus(Buffer.alloc(1))).rejects.toThrow(/not ready/);
  });
  it("cleans Gateway listeners on abort and ignores late dispatches", async () => {
    const gateway = new Gateway();
    const voice = new DiscordVoiceAdapter({ guildId: "g", channelId: "c", userId: "u", gateway });
    cleanups.push(() => voice.destroy());
    const abort = new AbortController();
    const pending = voice.connect(abort.signal);
    abort.abort();
    await expect(pending).rejects.toThrow();
    expect(gateway.listeners.size).toBe(0);
    expect(voice.state).toBe("disconnected");
  });
});
