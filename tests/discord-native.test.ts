import { createHash } from "node:crypto";
import { createSocket } from "node:dgram";
import { createServer } from "node:http";
import type { Duplex } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { DiscordVoiceAdapter } from "../src/discord.js";
import { createVoiceRuntime } from "../src/runtime.js";
import { decryptRtp, DISCORD_ENCRYPTION_MODE, OPUS_SILENCE } from "../src/rtp.js";

// Recorded gateway fixtures from Snazzah/davey (MIT), also used in dave.test.ts.
const external = Buffer.from(
  "404104ca1a2b102501d0672bd45ed74ffb83e078b2ba5b12c3f69fad56f083b6a35fc989c6736b5852b5aecdfcdf206e156d3d1dba8e3e5b2f89fc0c16f11614e84e4a00010100",
  "hex",
);
const proposals = Buffer.from(
  "41f000010001080cde77eadc823033000000000000000002000000000002000100010002404104a61acd34ff0548e6f767cc4df9619b51ba5814d52ee558284fc554405768e9e741ba32276414941b7c0190dcb5dfc3349a168f1247ecbdf6fc69f3eecab3765d404104f44da24e5aa9f73796fa38be115556e6b7d4f6ba55d2ecc3f1b9d198af6237e3fc8fc635996b6c76e77b4acace33f5cfd745ad0d540dd6f03f0da85c82e14714404104e7793985ed074af49568b53cf2e3974688279f02ee8d7c7df099ce3c7a1a28e747f59a7c7c23e9ef4f7815fb3469f39ea124f8b76712c41b763a55b867e6b48b00010802333999400200000200010200020000020001010000000000000000ffffffffffffffff0040483046022100d874dc777d4ede7e6d3374f737bc1394ac0ffd0635abdc9d02b3e359e059466a022100e62e97aefd5c6b32ff0ac5c5159dbe94f6f5a01bd0dd14a9dcc4d1e6248972ac004047304502205168abdf8d83a48daf8d5960afb305022de707c7496087feb43004c9fd2be5e80221008312a6f6df1ff593671a39f9966f6d1caef43e0c6d53c74300ba089ceeecfbf440473045022100cdbe804ba06a9be17615fe3c7f9055f31a6d0ea9402dd9fda6d109e9a3cb632b022067409e59f6b7f0a3eddd330a092a6c13d99d12abaebe0d6d40a0dae435c2a7a2",
  "hex",
);
const user = "158049329150427136";
const other = "158533742254751744";
const channel = "927310423890473011";
const audio = Buffer.from([0x78, 0x01, 0x02, 0x03]);
const key = Buffer.alloc(32, 42);
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2500;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Test condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Minimal RFC6455 peer copied from discord.test.ts; all client/native code is real. */
async function fixture(sessionVersion = 1) {
  const udp = createSocket("udp4");
  await new Promise<void>((resolve) => udp.bind(0, "127.0.0.1", resolve));
  const packets: Buffer[] = [];
  udp.on("message", (packet, remote) => {
    if (packet.length === 74 && packet.readUInt16BE(0) === 1) {
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
        if (message.op === 0) {
          send(8, { heartbeat_interval: 80 });
          send(2, {
            ip: "127.0.0.1",
            port: udp.address().port,
            ssrc: 1234,
            modes: [DISCORD_ENCRYPTION_MODE],
          });
        } else if (message.op === 3) send(6, { t: message.d.t });
        else if (message.op === 1)
          send(4, {
            mode: DISCORD_ENCRYPTION_MODE,
            secret_key: Array.from(key),
            dave_protocol_version: sessionVersion,
          });
      }
    });
  });
  cleanups.push(async () => {
    for (const peer of sockets) peer.destroy();
    udp.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test address");
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
  };
}

function adapter(
  endpoint: string,
  extra: Partial<ConstructorParameters<typeof DiscordVoiceAdapter>[0]> = {},
) {
  const voice = new DiscordVoiceAdapter({
    guildId: "123456789012345678",
    channelId: channel,
    userId: user,
    session: { endpoint, token: "token", sessionId: "session" },
    timeoutMs: 2500,
    ...extra,
  });
  cleanups.push(() => voice.destroy());
  return voice;
}

/** Decode just this fixture's MLS PublicMessage to split opcode 28 without spies. */
function commitFrom(frame: Buffer): Buffer {
  expect(frame[0]).toBe(28);
  const data = frame.subarray(1);
  let offset = 0;
  function u16() {
    const value = data.readUInt16BE(offset);
    offset += 2;
    return value;
  }
  function vector() {
    const width = 1 << (data[offset]! >> 6);
    if (width > 4) throw new Error("Invalid MLS vector length");
    const length =
      data.readUIntBE(offset, width) & (width === 1 ? 0x3f : width === 2 ? 0x3fff : 0x3fffffff);
    offset += width + length;
    if (offset > data.length) throw new Error("Truncated MLS vector");
  }
  expect(u16()).toBe(1); // MLS 1.0
  expect(u16()).toBe(1); // PublicMessage
  vector(); // group_id
  offset += 8; // epoch
  expect(data[offset++]).toBe(1); // member sender
  offset += 4; // leaf index
  vector(); // authenticated_data
  expect(data[offset++]).toBe(3); // commit
  vector(); // proposals
  expect(data[offset++]).toBe(0); // no update path for this initial commit
  vector(); // signature (variable-length native ECDSA)
  vector(); // confirmation_tag
  vector(); // membership_tag
  // Welcome begins with cipher suite 0x0002, not an MLSMessage header.
  expect(data.readUInt16BE(offset)).toBe(2);
  expect(data.length - offset).toBeGreaterThan(300);
  return data.subarray(0, offset);
}

async function playAndCheckTail(
  voice: DiscordVoiceAdapter,
  peer: Awaited<ReturnType<typeof fixture>>,
  encrypted: boolean,
) {
  const runtime = createVoiceRuntime(voice);
  cleanups.push(() => runtime.destroy());
  const start = performance.now();
  await runtime.play(
    (async function* () {
      yield audio;
    })(),
    { format: "opus", samples: 960 },
  );
  await until(
    () => peer.packets.length >= 6 && peer.messages.filter((m) => m.op === 5).length === 2,
  );
  expect(performance.now() - start).toBeGreaterThanOrEqual(90);
  expect(peer.packets).toHaveLength(6);
  expect(peer.messages.filter((m) => m.op === 5).map((m) => m.d.speaking)).toEqual([1, 0]);
  const payloads = peer.packets.map((packet) => decryptRtp(packet, key).subarray(12));
  if (encrypted) {
    expect(payloads[0]).not.toEqual(audio);
    expect(payloads[0]!.length).toBeGreaterThan(audio.length);
    expect(payloads[0]!.subarray(-2)).toEqual(Buffer.from([0xfa, 0xfa]));
  } else expect(payloads[0]).toEqual(audio);
  expect(payloads.slice(1)).toEqual(Array.from({ length: 5 }, () => OPUS_SILENCE));
  for (let i = 1; i < peer.packets.length; i++) {
    const previous = peer.packets[i - 1]!;
    const packet = peer.packets[i]!;
    expect(packet.readUInt16BE(2)).toBe((previous.readUInt16BE(2) + 1) & 0xffff);
    expect(packet.readUInt32BE(4)).toBe((previous.readUInt32BE(4) + 960) >>> 0);
  }
  await voice.endTransmission();
  await delay(40);
  expect(peer.packets).toHaveLength(6);
}

describe("Discord Voice with real DaveAdapter + native DAVESession and real sockets", () => {
  it("keeps connect pending through native MLS commit until execute, then plays immediately with five silence packets", async () => {
    const peer = await fixture();
    const voice = adapter(peer.endpoint);
    let connected = false;
    const connection = voice.connect().then(() => {
      connected = true;
    });
    // Attach rejection handling immediately, including if a fixture assertion fails.
    void connection.catch(() => {});
    await until(() => peer.binary.some((frame) => frame[0] === 26));
    expect(peer.binary.find((frame) => frame[0] === 26)!.length).toBeGreaterThan(300);
    await delay(30);
    expect(connected).toBe(false);
    expect(voice.state).toBe("connecting");
    expect(voice.daveVersion).toBe(1);
    peer.send(11, { user_ids: [other] }, 1);
    peer.sendBinary(2, 25, external);
    peer.sendBinary(3, 27, Buffer.concat([Buffer.from([0]), proposals]));
    await until(() => peer.binary.some((frame) => frame[0] === 28));
    expect(connected).toBe(false);
    const commit = commitFrom(peer.binary.find((frame) => frame[0] === 28)!);
    const transition = Buffer.alloc(2);
    transition.writeUInt16BE(0x1234);
    peer.sendBinary(4, 29, Buffer.concat([transition, commit]));
    await until(() => peer.messages.some((m) => m.op === 23 && m.d.transition_id === 0x1234));
    await delay(30);
    expect(connected).toBe(false);
    expect(voice.state).toBe("connecting");
    expect(peer.messages.some((m) => m.op === 31)).toBe(false);
    expect(peer.packets).toHaveLength(0);
    peer.send(22, { transition_id: 0x1234 }, 5);
    await connection;
    expect(voice.state).toBe("ready");
    await playAndCheckTail(voice, peer, true);
  });

  it.each(["timeout", "disconnect"] as const)(
    "rejects native version-1 connect without MLS keys on %s",
    async (ending) => {
      const peer = await fixture();
      const voice = adapter(peer.endpoint, { timeoutMs: ending === "timeout" ? 400 : 2500 });
      let settled = false;
      const connection = voice.connect();
      void connection.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      const rejected = expect(connection).rejects.toThrow(
        ending === "timeout" ? /timed out/ : /disconnect/i,
      );
      await until(() => peer.binary.some((frame) => frame[0] === 26));
      await delay(30);
      expect(settled).toBe(false);
      expect(voice.state).toBe("connecting");
      expect(voice.daveVersion).toBe(1);
      expect(peer.packets).toHaveLength(0);
      if (ending === "disconnect") voice.disconnect();
      await rejected;
      expect(voice.state).toBe("disconnected");
      expect(voice.connected).toBe(false);
    },
  );

  it("connects in explicit version-0 transport-only mode and immediately plays with five silence packets", async () => {
    const peer = await fixture(0);
    const voice = adapter(peer.endpoint, { requireDave: false });
    await voice.connect();
    expect(voice.state).toBe("ready");
    expect(voice.daveVersion).toBe(0);
    expect(peer.binary).toHaveLength(0);
    await playAndCheckTail(voice, peer, false);
  });
});
