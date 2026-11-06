import { type GatewayVoiceStateUpdate } from "discord-api-types/v10";
import { MiniEmitter } from "hemmiter";
export interface VoiceSession {
    sessionId: string;
    token: string;
    endpoint: string;
}
export interface GatewayDispatch {
    t: string;
    d: unknown;
}
export interface VoiceGateway {
    send(payload: GatewayVoiceStateUpdate): void;
    on(event: "dispatch", listener: (payload: GatewayDispatch) => void): unknown;
    off(event: "dispatch", listener: (payload: GatewayDispatch) => void): unknown;
}
export interface DiscordVoiceOptions {
    guildId: string;
    channelId: string;
    userId: string;
    session?: VoiceSession;
    gateway?: VoiceGateway;
    requireDave?: boolean;
    timeoutMs?: number;
    selfDeaf?: boolean;
    selfMute?: boolean;
}
export type DiscordVoiceState = "disconnected" | "connecting" | "ready" | "destroyed";
export type DiscordVoiceEvents = {
    stateChange: [state: DiscordVoiceState];
    ready: [];
    disconnect: [reason: Error | undefined];
    error: [error: Error];
};
/** Encoded Opus sink; framing, pacing, and audio encoding belong to the caller. */
export declare class DiscordVoiceAdapter extends MiniEmitter<DiscordVoiceEvents> {
    private attempt;
    private currentState;
    readonly options: Readonly<DiscordVoiceOptions>;
    constructor(options: DiscordVoiceOptions);
    get state(): DiscordVoiceState;
    get connected(): boolean;
    get daveVersion(): number;
    private stateTo;
    private active;
    connect(signal?: AbortSignal): Promise<void>;
    private join;
    private open;
    private sendJson;
    private message;
    private readonly acks;
    sendOpus(packet: Buffer, samples?: number, signal?: AbortSignal): Promise<void>;
    /** Flush Discord's decoder with five paced silence frames before clearing speaking. */
    endTransmission(): Promise<void>;
    private fail;
    private stop;
    disconnect(): void;
    destroy(): void;
}
//# sourceMappingURL=discord.d.ts.map