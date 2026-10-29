/** Opt-in live test. Run one backend at a time; never print credentials. */
import { createReadStream } from "node:fs";
import { once } from "node:events";
import { Readable } from "node:stream";
import { Client, Events, GatewayIntentBits } from "discord.js";
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  type VoiceConnection,
} from "@discordjs/voice";
import {
  createDiscordJsVoiceAdapter,
  createOpusCodec,
  createVoiceRuntime,
  framePcm,
  type AudioSource,
  type DiscordVoiceAdapter,
  type VoiceRuntime,
} from "../dist/index.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function main(): Promise<void> {
  if (process.env.VOICE_COMPARE !== "1") {
    console.log("Skipped: set VOICE_COMPARE=1 to connect a bot to a test guild.");
    return;
  }
  const backend = process.env.VOICE_BACKEND ?? "hyperttp";
  if (backend !== "hyperttp" && backend !== "discordjs")
    throw new Error("VOICE_BACKEND must be hyperttp or discordjs");
  const token = required("DISCORD_TOKEN");
  const guildId = required("VOICE_GUILD_ID");
  const channelId = required("VOICE_CHANNEL_ID");
  const path = process.env.VOICE_PCM_FILE;
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });
  const controller = new AbortController();
  const signal = controller.signal;
  const cancel = (): void => controller.abort(new Error("Comparison cancelled"));
  const timer = setTimeout(cancel, 120_000);
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  const codec = createOpusCodec({ channels: 2 });
  const input = path ? createReadStream(path) : undefined;
  let voice: DiscordVoiceAdapter | undefined;
  let runtime: VoiceRuntime | undefined;
  let connection: VoiceConnection | undefined;
  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
  // Abort destroys both backends promptly, including an in-flight bot login.
  const abort = (): void => {
    voice?.destroy();
    connection?.destroy();
    player.stop(true);
    input?.destroy();
    void client.destroy();
  };
  signal.addEventListener("abort", abort, { once: true });
  async function* tone(): AsyncGenerator<Buffer> {
    for (let frame = 0; frame < 500; frame++) {
      signal.throwIfAborted();
      const pcm = Buffer.alloc(3840);
      for (let sample = 0; sample < 960; sample++) {
        const value = Math.round(
          3000 * Math.sin((2 * Math.PI * 440 * (frame * 960 + sample)) / 48000),
        );
        pcm.writeInt16LE(value, sample * 4);
        pcm.writeInt16LE(value, sample * 4 + 2);
      }
      yield pcm;
    }
  }
  async function* packets(source: AudioSource): AsyncGenerator<Buffer> {
    for await (const pcm of framePcm(source, { channels: 2, signal }))
      yield codec.encode(Buffer.from(pcm));
  }
  try {
    const ready = once(client, Events.ClientReady, { signal });
    // Attach rejection handlers before starting login.
    await Promise.all([ready, client.login(token)]);
    signal.throwIfAborted();
    const guild = await client.guilds.fetch(guildId);
    if (!client.user) throw new Error("Bot user unavailable");
    const channel = await guild.channels.fetch(channelId);
    if (!channel?.isVoiceBased()) throw new Error("VOICE_CHANNEL_ID must identify a voice channel");
    const source = packets(input ?? tone());
    console.log(`Backend: ${backend}; source: ${path ? "PCM file" : "quiet 10s 440 Hz tone"}`);
    const start = performance.now();
    if (backend === "hyperttp") {
      voice = createDiscordJsVoiceAdapter({
        guildId,
        channelId,
        userId: client.user.id,
        adapterCreator: guild.voiceAdapterCreator,
        timeoutMs: 30_000,
      });
      voice.on("error", () => console.error("Hyperttp connection error (details omitted)."));
      runtime = createVoiceRuntime(voice, { diagnostics: true });
      runtime.on("error", () => console.error("Hyperttp playback error (details omitted)."));
      await voice.connect(signal);
      console.log(`Ready after ${Math.round(performance.now() - start)} ms`);
      await runtime.play(source, { format: "opus", samples: 960, signal });
      console.log("Hyperttp diagnostics:", runtime.diagnostics);
    } else {
      connection = joinVoiceChannel({
        guildId,
        channelId,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: true,
      });
      connection.on("error", () => controller.abort(new Error("Discordjs connection failed")));
      await entersState(connection, VoiceConnectionStatus.Ready, signal);
      console.log(`Ready after ${Math.round(performance.now() - start)} ms`);
      connection.subscribe(player);
      const stream = Readable.from(source, { objectMode: true, highWaterMark: 1 });
      stream.on("error", () => controller.abort(new Error("Audio source failed")));
      try {
        const finished = once(player, AudioPlayerStatus.Idle, { signal });
        player.play(createAudioResource(stream, { inputType: StreamType.Opus }));
        await finished;
      } finally {
        stream.destroy();
      }
    }
    console.log(
      "Playback finished. Confirm audibility with a listener; this is not a performance verdict.",
    );
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
    try {
      await runtime?.destroy();
    } finally {
      voice?.destroy();
      if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed)
        connection.destroy();
      player.stop(true);
      input?.destroy();
      codec.close();
      await client.destroy();
    }
  }
}

try {
  await main();
} catch {
  console.error(
    "Comparison failed: check environment, permissions, native modules and session state. Sensitive error details omitted.",
  );
  process.exitCode = 1;
}
