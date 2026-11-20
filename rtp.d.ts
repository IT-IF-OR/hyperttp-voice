import { VoiceEncryptionMode } from "discord-api-types/voice/v8";
export declare const DISCORD_ENCRYPTION_MODE = VoiceEncryptionMode.AeadAes256GcmRtpSize;
export declare const OPUS_SILENCE: Buffer<ArrayBuffer>;
/** SRTP clear header: fixed header, CSRC list, and extension preamble (not extension data). */
export declare function rtpHeaderSize(packet: Buffer): number;
export declare function encryptRtp(packet: Buffer, key: Buffer, counter: number): Buffer;
export declare function decryptRtp(packet: Buffer, key: Buffer): Buffer;
export interface RtpOptions {
    sequence?: number;
    timestamp?: number;
    nonce?: number;
}
/** One instance per transport key. A nonce is never reused, even when UDP sending fails. */
export declare class RtpSender {
    readonly ssrc: number;
    private sequence;
    private timestamp;
    private nonce;
    private readonly key;
    constructor(ssrc: number, key: Buffer, options?: RtpOptions);
    packet(opus: Buffer, samples?: number): Buffer;
    destroy(): void;
}
export declare function discoveryRequest(ssrc: number): Buffer;
export declare function parseDiscoveryResponse(packet: Buffer, ssrc: number): {
    address: string;
    port: number;
};
//# sourceMappingURL=rtp.d.ts.map