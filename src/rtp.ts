import { VoiceEncryptionMode } from "discord-api-types/voice/v8";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const DISCORD_ENCRYPTION_MODE = VoiceEncryptionMode.AeadAes256GcmRtpSize;
export const OPUS_SILENCE = Buffer.from([0xf8, 0xff, 0xfe]);

function uint(value: number, max: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new RangeError(`${name} must be an unsigned integer <= ${max}`);
  }
}

/** SRTP clear header: fixed header, CSRC list, and extension preamble (not extension data). */
export function rtpHeaderSize(packet: Buffer): number {
  if (packet.length < 12 || packet[0]! >>> 6 !== 2) throw new Error("Invalid RTP header");
  const size = 12 + (packet[0]! & 0x0f) * 4 + (packet[0]! & 0x10 ? 4 : 0);
  if (packet.length < size) throw new Error("Truncated RTP header");
  return size;
}

export function encryptRtp(packet: Buffer, key: Buffer, counter: number): Buffer {
  uint(counter, 0xffffffff, "nonce");
  if (key.length !== 32) throw new Error("AES-256-GCM requires a 32-byte key");
  const size = rtpHeaderSize(packet);
  const nonce = Buffer.alloc(12);
  nonce.writeUInt32BE(counter, 0);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(packet.subarray(0, size));
  return Buffer.concat([
    packet.subarray(0, size),
    cipher.update(packet.subarray(size)),
    cipher.final(),
    cipher.getAuthTag(),
    nonce.subarray(0, 4),
  ]);
}

export function decryptRtp(packet: Buffer, key: Buffer): Buffer {
  if (key.length !== 32) throw new Error("AES-256-GCM requires a 32-byte key");
  const size = rtpHeaderSize(packet);
  if (packet.length < size + 20) throw new Error("Truncated encrypted RTP packet");
  const nonce = Buffer.alloc(12);
  packet.copy(nonce, 0, packet.length - 4);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(packet.subarray(0, size));
  decipher.setAuthTag(packet.subarray(packet.length - 20, packet.length - 4));
  return Buffer.concat([
    packet.subarray(0, size),
    decipher.update(packet.subarray(size, -20)),
    decipher.final(),
  ]);
}

export interface RtpOptions {
  sequence?: number;
  timestamp?: number;
  nonce?: number;
}

/** One instance per transport key. A nonce is never reused, even when UDP sending fails. */
export class RtpSender {
  private sequence: number;
  private timestamp: number;
  private nonce: number;
  private readonly key: Buffer;

  constructor(
    readonly ssrc: number,
    key: Buffer,
    options: RtpOptions = {},
  ) {
    uint(ssrc, 0xffffffff, "SSRC");
    if (key.length !== 32) throw new Error("AES-256-GCM requires a 32-byte key");
    this.key = Buffer.from(key);
    this.sequence = options.sequence ?? randomBytes(2).readUInt16BE();
    this.timestamp = options.timestamp ?? randomBytes(4).readUInt32BE();
    this.nonce = options.nonce ?? 0;
    uint(this.sequence, 0xffff, "sequence");
    uint(this.timestamp, 0xffffffff, "timestamp");
    uint(this.nonce, 0xffffffff, "nonce");
  }

  packet(opus: Buffer, samples = 960): Buffer {
    if (!Number.isInteger(samples) || samples <= 0 || samples > 5760) {
      throw new RangeError("samples must be 1..5760 at 48 kHz");
    }
    if (this.nonce > 0xffffffff)
      throw new Error("Transport nonce exhausted; reconnect with a fresh key");
    const header = Buffer.alloc(12);
    header[0] = 0x80;
    header[1] = 0x78;
    header.writeUInt16BE(this.sequence, 2);
    header.writeUInt32BE(this.timestamp, 4);
    header.writeUInt32BE(this.ssrc, 8);
    const packet = encryptRtp(Buffer.concat([header, opus]), this.key, this.nonce++);
    this.sequence = (this.sequence + 1) & 0xffff;
    this.timestamp = (this.timestamp + samples) >>> 0;
    return packet;
  }

  destroy(): void {
    this.key.fill(0);
    this.nonce = 0x100000000;
  }
}

export function discoveryRequest(ssrc: number): Buffer {
  uint(ssrc, 0xffffffff, "SSRC");
  const packet = Buffer.alloc(74);
  packet.writeUInt16BE(1, 0);
  packet.writeUInt16BE(70, 2);
  packet.writeUInt32BE(ssrc, 4);
  return packet;
}

export function parseDiscoveryResponse(
  packet: Buffer,
  ssrc: number,
): { address: string; port: number } {
  if (
    packet.length !== 74 ||
    packet.readUInt16BE(0) !== 2 ||
    packet.readUInt16BE(2) !== 70 ||
    packet.readUInt32BE(4) !== ssrc
  ) {
    throw new Error("Invalid UDP discovery response");
  }
  const end = packet.indexOf(0, 8);
  if (end < 9 || end > 71) throw new Error("Invalid UDP discovery address");
  const address = packet.toString("ascii", 8, end);
  const port = packet.readUInt16BE(72);
  if (port === 0) throw new Error("Invalid UDP discovery port");
  return { address, port };
}
