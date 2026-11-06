import { type GatewayVoiceServerUpdateDispatchData, type GatewayVoiceStateUpdateDispatchData, type GatewayVoiceStateUpdate } from "discord-api-types/v10";
import { DiscordVoiceAdapter, type DiscordVoiceOptions } from "./discord.js";
/** Structurally compatible with discord.js Guild.voiceAdapterCreator. */
export type DiscordGatewayAdapterCreator = (methods: {
    onVoiceServerUpdate(data: GatewayVoiceServerUpdateDispatchData): void;
    onVoiceStateUpdate(data: GatewayVoiceStateUpdateDispatchData): void;
    destroy(): void;
}) => {
    sendPayload(payload: GatewayVoiceStateUpdate): boolean;
    destroy(): void;
};
export type DiscordJsVoiceOptions = Omit<DiscordVoiceOptions, "gateway" | "session"> & {
    adapterCreator: DiscordGatewayAdapterCreator;
};
/** Reuses a discord.js guild Gateway, without importing discord.js or @discordjs/voice. */
export declare function createDiscordJsVoiceAdapter(options: DiscordJsVoiceOptions): DiscordVoiceAdapter;
//# sourceMappingURL=discordjs.d.ts.map