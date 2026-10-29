import { VoiceOpcodes, type VoiceDaveTransitionReadyData } from "discord-api-types/voice/v8";
/** DAVE signaling payloads exclude the voice WebSocket sequence/opcode headers. */
export declare class DaveAdapter {
    private readonly userId;
    private readonly channelId;
    private readonly sendJson;
    private readonly sendBinary;
    readonly maxProtocolVersion: number;
    private currentVersion;
    private configured;
    private destroyed;
    private failed;
    private session;
    private epochVersion;
    private readonly members;
    private readonly transitions;
    private awaitingExecute;
    private readonly requireDave;
    private readonly readinessListeners;
    get ready(): boolean;
    waitUntilReady(signal?: AbortSignal, timeoutMs?: number): Promise<void>;
    private notifyReadiness;
    constructor(userId: string, channelId: string, sendJson: (op: VoiceOpcodes.DaveTransitionReady | VoiceOpcodes.DaveMlsInvalidCommitWelcome, data: VoiceDaveTransitionReadyData) => void, sendBinary: (op: number, payload: Buffer) => void, options?: {
        requireDave?: boolean;
    });
    get version(): number;
    private alive;
    private protocol;
    private guard;
    private initialize;
    configure(version: number): void;
    private native;
    private execute;
    handleJson(op: number, data: unknown): boolean;
    handleBinary(op: number, payload: Buffer): boolean;
    encrypt(packet: Buffer): Buffer;
    destroy(): void;
}
//# sourceMappingURL=dave.d.ts.map