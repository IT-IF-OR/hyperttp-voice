import {
  GatewayDispatchEvents,
  type GatewayVoiceServerUpdateDispatchData,
  type GatewayVoiceStateUpdateDispatchData,
  type GatewayVoiceStateUpdate,
} from "discord-api-types/v10";
import {
  DiscordVoiceAdapter,
  type DiscordVoiceOptions,
  type GatewayDispatch,
  type VoiceGateway,
} from "./discord.js";

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
export function createDiscordJsVoiceAdapter(options: DiscordJsVoiceOptions): DiscordVoiceAdapter {
  const listeners = new Set<(payload: GatewayDispatch) => void>();
  let adapter: ReturnType<DiscordGatewayAdapterCreator> | undefined;
  let creating = false;
  let invalidated = false;
  let generation: object | undefined;
  const release = (): void => {
    const previous = adapter;
    adapter = undefined;
    generation = undefined;
    previous?.destroy();
  };
  const dispatch = (payload: GatewayDispatch): void => {
    for (const listener of listeners) listener(payload);
  };
  const gateway: VoiceGateway = {
    send(payload) {
      if (!adapter?.sendPayload(payload))
        throw new Error("Discord Gateway rejected voice state update");
    },
    on(_event, listener) {
      listeners.add(listener);
      if (adapter) return;
      creating = true;
      const current = {};
      generation = current;
      invalidated = false;
      try {
        const next = options.adapterCreator({
          onVoiceServerUpdate: (data) => {
            if (generation === current)
              dispatch({ t: GatewayDispatchEvents.VoiceServerUpdate, d: data });
          },
          onVoiceStateUpdate: (data) => {
            if (generation === current)
              dispatch({ t: GatewayDispatchEvents.VoiceStateUpdate, d: data });
          },
          destroy: () => {
            if (generation !== current) return;
            invalidated = true;
            if (!creating) voice.disconnect();
          },
        });
        if (invalidated) {
          next.destroy();
          throw new Error("Discord Gateway adapter was destroyed during creation");
        }
        adapter = next;
      } catch (error) {
        generation = undefined;
        listeners.delete(listener);
        throw error;
      } finally {
        creating = false;
      }
    },
    off(_event, listener) {
      listeners.delete(listener);
    },
  };
  const { adapterCreator: _adapterCreator, ...connectionOptions } = options;
  const voice = new DiscordVoiceAdapter({ ...connectionOptions, gateway });
  // DiscordVoiceAdapter first sends the leave command, then emits disconnect.
  voice.on("disconnect", release);
  return voice;
}
