// Импорт dist выполняется только после явного согласия: обычный запуск не открывает сеть.
if (process.env.VOICE_SMOKE !== "1") {
  console.log("Skipped: set VOICE_SMOKE=1 and all required VOICE_* session variables.");
} else {
  function required(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`Missing environment variable: ${name}`);
    return value;
  }
  async function run(): Promise<void> {
    const options = {
      guildId: required("VOICE_GUILD_ID"),
      channelId: required("VOICE_CHANNEL_ID"),
      userId: required("VOICE_USER_ID"),
      session: {
        sessionId: required("VOICE_SESSION_ID"),
        token: required("VOICE_TOKEN"),
        endpoint: required("VOICE_ENDPOINT"),
      },
      requireDave: true,
      timeoutMs: 20_000,
    };
    const { DiscordVoiceAdapter, createVoiceRuntime, PCM_FRAME_BYTES } =
      await import("../dist/index.js");
    const voice = new DiscordVoiceAdapter(options);
    const runtime = createVoiceRuntime(voice, { channels: 2 });
    const controller = new AbortController();
    const cancel = () => controller.abort();
    const timer = setTimeout(cancel, 30_000);
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    async function* tone() {
      // Low-volume 440 Hz stereo tone; continuity is maintained across frame boundaries.
      for (let frame = 0; frame < 250; frame++) {
        const pcm = Buffer.alloc(PCM_FRAME_BYTES);
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
    try {
      await voice.connect(controller.signal);
      await runtime.play(tone(), { signal: controller.signal });
      console.log(
        "Smoke completed: 5s quiet 440 Hz tone and silence tail sent. Confirm audibility with a listener; delivery alone is not proof.",
      );
    } finally {
      clearTimeout(timer);
      process.off("SIGINT", cancel);
      process.off("SIGTERM", cancel);
      try {
        await runtime.destroy();
      } finally {
        voice.destroy();
      }
    }
  }
  try {
    await run();
  } catch {
    // Не печатаем ошибки сервера/URL: они могут содержать чувствительные данные.
    console.error(
      "Voice smoke failed; check session freshness, permissions, connectivity and DAVE readiness.",
    );
    process.exitCode = 1;
  }
}

export {};
