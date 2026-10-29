import { createReadStream } from "node:fs";
import { DiscordVoiceAdapter, createVoiceRuntime, type VoiceGateway } from "@hyperttp/voice";

/** Gateway должен быть уже авторизован приложением и передавать dispatch-события. */
export async function playDiscordPcm(
  gateway: VoiceGateway,
  ids: { guildId: string; channelId: string; userId: string },
  pcmPath: string,
  signal?: AbortSignal,
): Promise<void> {
  const voice = new DiscordVoiceAdapter({ ...ids, gateway, requireDave: true });
  const runtime = createVoiceRuntime(voice, { channels: 2 });
  // Только raw 48 kHz stereo s16le, не MP3/WAV/контейнер Opus.
  const input = createReadStream(pcmPath);
  try {
    await voice.connect(signal);
    await runtime.play(input, signal ? { signal } : {});
  } finally {
    try {
      await runtime.destroy();
    } finally {
      input.destroy();
      voice.destroy();
    }
  }
}
