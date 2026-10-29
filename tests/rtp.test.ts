import { createDecipheriv } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  RtpSender,
  decryptRtp,
  discoveryRequest,
  encryptRtp,
  parseDiscoveryResponse,
  rtpHeaderSize,
} from "../src/rtp.js";

const key = Buffer.alloc(32, 42);
describe("Discord RTP-size AES-256-GCM", () => {
  it("uses RTP AAD, a 12-byte nonce, tag then four-byte counter suffix", () => {
    const sender = new RtpSender(123, key, { sequence: 65535, timestamp: 0xfffffff0, nonce: 7 });
    const packet = sender.packet(Buffer.from("opus"), 960);
    expect(packet.subarray(0, 12).toString("hex")).toBe("8078fffffffffff00000007b");
    expect(packet.readUInt32BE(packet.length - 4)).toBe(7);
    const nonce = Buffer.alloc(12);
    nonce.writeUInt32BE(7);
    const decoder = createDecipheriv("aes-256-gcm", key, nonce);
    decoder.setAAD(packet.subarray(0, 12));
    decoder.setAuthTag(packet.subarray(-20, -4));
    expect(
      Buffer.concat([decoder.update(packet.subarray(12, -20)), decoder.final()]).toString(),
    ).toBe("opus");
    const next = sender.packet(Buffer.from("next"));
    expect(next.readUInt16BE(2)).toBe(0);
    expect(next.readUInt32BE(4)).toBe(944);
    expect(next.readUInt32BE(next.length - 4)).toBe(8);
  });
  it("authenticates headers, ciphertext, tags and nonce", () => {
    const packet = new RtpSender(2, key).packet(Buffer.from("opus"));
    expect(decryptRtp(packet, key).subarray(12).toString()).toBe("opus");
    for (const position of [3, 12, packet.length - 5, packet.length - 1]) {
      const changed = Buffer.from(packet);
      changed[position]! ^= 1;
      expect(() => decryptRtp(changed, key)).toThrow();
    }
  });
  it("leaves CSRCs and extension preamble clear, encrypts extension data", () => {
    const header = Buffer.alloc(20);
    header[0] = 0x91;
    header[1] = 0x78;
    header.writeUInt16BE(0xbede, 16);
    header.writeUInt16BE(1, 18);
    const raw = Buffer.concat([header, Buffer.from([1, 2, 3, 4]), Buffer.from("opus")]);
    const encrypted = encryptRtp(raw, key, 1);
    expect(rtpHeaderSize(raw)).toBe(20);
    expect(encrypted.subarray(0, 20)).toEqual(header);
    expect(decryptRtp(encrypted, key)).toEqual(raw);
  });
  it("refuses nonce reuse after exhaustion and validates input", () => {
    const sender = new RtpSender(1, key, { nonce: 0xffffffff });
    sender.packet(Buffer.alloc(3));
    expect(() => sender.packet(Buffer.alloc(3))).toThrow(/exhausted/);
    expect(() => new RtpSender(1, Buffer.alloc(31))).toThrow(/32-byte/);
    expect(() => new RtpSender(-1, key)).toThrow();
    expect(() => new RtpSender(1, key).packet(Buffer.alloc(3), 0)).toThrow(/samples/);
    expect(() => decryptRtp(Buffer.alloc(12), key)).toThrow();
    sender.destroy();
    sender.destroy();
  });
});
describe("UDP discovery", () => {
  it("encodes and parses the actual 74-byte protocol", () => {
    const response = discoveryRequest(123);
    expect(response.length).toBe(74);
    expect(response.readUInt16BE(2)).toBe(70);
    response.writeUInt16BE(2);
    response.write("127.0.0.1", 8);
    response.writeUInt16BE(5555, 72);
    expect(parseDiscoveryResponse(response, 123)).toEqual({ address: "127.0.0.1", port: 5555 });
    expect(() => parseDiscoveryResponse(response, 124)).toThrow();
    expect(() => parseDiscoveryResponse(response.subarray(1), 123)).toThrow();
    response.fill(65, 8, 72);
    expect(() => parseDiscoveryResponse(response, 123)).toThrow(/address/);
  });
});
