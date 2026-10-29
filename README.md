# hyperttp-voice

Серверный voice/audio runtime для Hyperttp: PCM → Opus → Discord Voice (DAVE + RTP), а также отдельный WebRTC PCM bridge на `HyperClient` из `hyperttp` и WebRTC transport.

## Установка и сборка

```sh
npm install @hyperttp/voice @hyperttp/types@0.4.2
```

Для работы из репозитория:

```sh
bun install
npm run build
npm run typecheck
npm test
```

Пакет ESM, `engines.node >=26`. Проверены **Linux x64, Node.js 26.12.0 и Bun 1.4.3**: native Opus/DAVE и локальные тесты. Другие платформы не проверены. Реальная Discord-сессия и слышимость требуют отдельной opt-in проверки.

Внешний **FFmpeg с libopus обязателен только для WebRTC PCM bridge** (`ffmpeg` в PATH или `ffmpegPath`). Discord/runtime используют native `libopus-node` и `@snazzah/davey`, без FFmpeg. Доступность prebuilt native binaries зависит от платформы.

## Публичный API

Корневой импорт `@hyperttp/voice` предназначен для экспортов `audio`, `runtime`, `codec`, `discord`, `dave`, `rtp`:

| Модуль  | Основные API                                                                                                                     |
| ------- | -------------------------------------------------------------------------------------------------------------------------------- |
| audio   | `framePcm`, `AudioSource`, `PcmOptions`, `PCM_SAMPLE_RATE`, `PCM_FRAME_SAMPLES`, `PCM_FRAME_MS`, `PCM_FRAME_BYTES`               |
| runtime | `VoiceRuntime`, `createVoiceRuntime`, `AudioSink`, `PlayOptions`, `createMetadataCache<T>({ ttl?, maxSize? })`                   |
| codec   | `NativeOpusCodec`, `createOpusCodec`, `OpusCodec`                                                                                |
| discord | `DiscordVoiceAdapter`, `VoiceGateway`, `DiscordVoiceOptions`, `VoiceSession`                                                     |
| dave    | `DaveAdapter`                                                                                                                    |
| rtp     | `RtpSender`, `encryptRtp`, `decryptRtp`, `discoveryRequest`, `parseDiscoveryResponse`, `DISCORD_ENCRYPTION_MODE`, `OPUS_SILENCE` |

WebRTC импортируется отдельно: `import { createWebRtcAudio } from "@hyperttp/voice/webrtc"`. Имена модулей в таблице — не обещание отдельных subpath-экспортов `/audio` и т. п.

**Готовность Discord:** `connect()` ждёт transport и DAVE-ready; во время переходов MLS отправка приостанавливается с ограниченным ожиданием и отменой. Runtime завершает передачу пятью paced silence-пакетами и speaking=0. Автоматического reconnect/resume пока нет. Подробный план переключения backend и live-чеклист: [миграция ragu2](docs/migration-ragu2.md).

## Замена используемых API `@discordjs/voice`

Это **не drop-in замена импортов**: не нужно переименовывать `@discordjs/voice` в `@hyperttp/voice`, сохраняя прежний код. Для подключения через существующий discord.js client уже есть мост `createDiscordJsVoiceAdapter`, принимающий `guild.voiceAdapterCreator`, без runtime-зависимости от discord.js.

| Сейчас                                                       | В `@hyperttp/voice`                                                                              |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `DiscordGatewayAdapterCreator`                               | Совместимый структурный тип экспортируется; обычно выводится из `guild.voiceAdapterCreator`      |
| `joinVoiceChannel(...)`                                      | `createDiscordJsVoiceAdapter(...)`, затем `await voice.connect(signal)`                          |
| `entersState(connection, VoiceConnectionStatus.Ready, ...)`  | `await voice.connect(signal)` — ждёт transport и DAVE-ready                                      |
| `VoiceConnection`                                            | `DiscordVoiceAdapter`                                                                            |
| `VoiceConnectionStatus`                                      | `voice.state`: `disconnected`, `connecting`, `ready`, `destroyed`                                |
| `getVoiceConnection(guildId)`                                | Хранить собственный `Map<string, DiscordVoiceAdapter>`; глобального реестра нет                  |
| `createAudioPlayer()`                                        | `createVoiceRuntime(voice)`                                                                      |
| `createAudioResource(stream, { inputType: StreamType.Raw })` | `runtime.play(stream)` — PCM 48k stereo s16le                                                    |
| `StreamType.Opus`                                            | `runtime.play(packets, { format: "opus", samples: 960 })`                                        |
| `StreamType.Arbitrary`, `OggOpus`, `WebmOpus`                | Встроенного decode/demux нет; подготовить PCM или отдельные Opus packets                         |
| `AudioPlayerStatus`                                          | `runtime.state`: `idle`, `playing`, `paused`, `destroyed`; события `audioStart/Pause/Resume/End` |
| `NoSubscriberBehavior`                                       | Модели subscriptions нет: один runtime связан с одним sink                                       |

Минимальный вариант в уже авторизованном discord.js-приложении:

```ts
import { createReadStream } from "node:fs";
import { createDiscordJsVoiceAdapter, createVoiceRuntime } from "@hyperttp/voice";

const voice = createDiscordJsVoiceAdapter({
  guildId: guild.id,
  channelId: voiceChannel.id,
  userId: client.user.id,
  adapterCreator: guild.voiceAdapterCreator,
  timeoutMs: 30_000,
});
const player = createVoiceRuntime(voice);
voice.on("error", () => console.error("Voice connection failed"));
player.on("error", () => console.error("Audio playback failed"));

try {
  await voice.connect();
  // Raw PCM, не MP3/WAV/Ogg. play() завершается после окончания передачи.
  const playback = player.play(createReadStream("music.pcm"));
  // В обработчиках команд: player.pause(); player.resume(); await player.stop();
  await playback;
} finally {
  try {
    await player.destroy();
  } finally {
    voice.destroy();
  }
}
```

Требуется intent `GuildVoiceStates`. Для одной guild нельзя одновременно использовать два voice backend: оба регистрируют Gateway adapter этой guild.

### Запускаемое A/B-сравнение

[`examples/compare-discord.ts`](examples/compare-discord.ts) создаёт bot client, подключается и проигрывает тихий 10-секундный тон, либо один и тот же raw PCM-файл. Оба backend получают **одинаковые 20-мс Opus-пакеты из `libopus-node`**, чтобы не сравнивать разные кодировщики. `discord.js` и `@discordjs/voice` установлены только как devDependencies; в runtime пакета их нет.

Задайте `DISCORD_TOKEN`, `VOICE_GUILD_ID`, `VOICE_CHANNEL_ID` безопасным способом (не сохраняйте token в git/истории shell). Затем **по очереди**:

```sh
VOICE_COMPARE=1 VOICE_BACKEND=hyperttp npm run compare:discord
VOICE_COMPARE=1 VOICE_BACKEND=discordjs npm run compare:discord
# Необязательно: VOICE_PCM_FILE=/absolute/path/music.pcm
```

Bot должен иметь View Channel, Connect и Speak. Обычный запуск без `VOICE_COMPARE=1` не подключается к Discord. Таймаут всей проверки — 120 секунд. Вариант hyperttp начинает play сразу после connect, проверяя DAVE-ready без искусственного sleep. Успешный запуск не подтверждает слышимость: нужен слушатель. Это функциональное сравнение, не честный throughput/CPU benchmark; automatic reconnect и полная совместимость поведения не заявляются.

Проверка типов примера: `npm run build && npm run typecheck:compare`.

## Discord: воспроизведение PCM

Приложение само авторизует Discord Gateway, передаёт dispatch-события и реализует `VoiceGateway.send/on/off`. Библиотека не создаёт bot client и не управляет его токеном.

```ts
import { createReadStream } from "node:fs";
import { DiscordVoiceAdapter, createVoiceRuntime, type VoiceGateway } from "@hyperttp/voice";

export async function playMusic(
  gateway: VoiceGateway,
  ids: { guildId: string; channelId: string; userId: string },
  pcmPath: string,
) {
  const voice = new DiscordVoiceAdapter({ ...ids, gateway });
  const runtime = createVoiceRuntime(voice, { channels: 2 });
  const input = createReadStream(pcmPath);
  try {
    await voice.connect();
    await runtime.play(input);
  } finally {
    try {
      await runtime.destroy();
    } finally {
      input.destroy();
      voice.destroy();
    }
  }
}
```

Полный пример с отменой: [`examples/discord-playback.ts`](examples/discord-playback.ts).

Вход — **raw 48 000 Гц, stereo, interleaved signed 16-bit little-endian PCM**, не MP3, WAV или Ogg. MP3 нужно заранее декодировать, например внешним инструментом:

```sh
ffmpeg -i music.mp3 -f s16le -ar 48000 -ac 2 music.pcm
```

Один stereo-кадр: 960 samples на канал, 20 мс, 3840 байт. Runtime также поддерживает mono (`channels: 1`, 1920 байт), дробит произвольные чанки, по умолчанию дополняет последний неполный 20-мс кадр нулями; `tail: "error"` запрещает это. Оборванный interleaved sample всегда ошибка. Лимит входного чанка по умолчанию 1 MiB; производитель должен ограничивать собственные очереди.

Runtime задаёт pacing, не пытаясь догонять пропущенные тики, поддерживает `pause()`, `resume()`, `stop()`, `destroy()` и `AbortSignal`. `resume()` здесь относится только к аудиопаузе, не к Discord reconnect. Источники — `AsyncIterable<Uint8Array>` или `ReadableStream<Uint8Array>`; для освобождения ресурсов производитель должен корректно поддерживать `return()`/`cancel()`.

Для уже закодированного Opus каждый чанк должен быть **одним пакетом на 20 мс**:

```ts
await runtime.play(opusPackets, { format: "opus", samples: 960 });
```

Это bypass кодировщика, не demux контейнера. `DiscordVoiceAdapter.sendOpus()` сам не выполняет framing/pacing. `connect()` ждёт transport и DAVE-ready; при последующих MLS-переходах отправка ожидает готовности с таймаутом и отменой, без plaintext fallback.

## WebRTC PCM bridge

Обычное подключение использует автоматическую загрузку установленных WebRTC-пакетов:

```ts
import { HyperClient } from "hyperttp";
import type {} from "@hyperttp/protocol-webrtc"; // TypeScript augmentation, без runtime-регистрации

const client = new HyperClient();
try {
  await client.webrtc.connect(peerUrl);
} finally {
  await client.destroy();
}
```

`@hyperttp/protocol-webrtc` и `@hyperttp/transport-webrtc` остаются установленными зависимостями. Для обычного клиента вручную регистрировать их не нужно. PCM-мост создаёт свой transport ради управления подписками; при custom `handler` задаёт полный протокол, поскольку receiver-only регистрация в ядре 2.0.5 скрывает lazy sender namespace. Media frames не проходят через HTTP/plugin pipeline.

[`examples/webrtc-pcm.ts`](examples/webrtc-pcm.ts) показывает `createWebRtcAudio(input)`, `audio.client.webrtc.stream(peerUrl, audio.stream)`, ожидание `audio.done` и `audio.close()` в `finally`. Получатель и signaling/ICE должны быть настроены приложением; это не автономный HTTP/signaling server.

Bridge использует `hyperttp@^0.6.2` (`HyperClient`, ядро `@hyperttp/core@2.0.5`) и Werift transport. `audio.client` — основной интерфейс; `audio.core` оставлен как deprecated alias того же HyperClient. Настройки и плагины передаются через `createWebRtcAudio(input, { client: { plugins: [...] } })`. Один live PCM source/FFmpeg encoder обслуживает независимые подписки без replay для поздних участников. FFmpeg отвечает за encoding/pacing; второй кодировщик runtime поверх bridge не нужен. EOF, ошибка input или отмена закрывают адаптер целиком. `close()` идемпотентен; `done` сообщает ошибки источника/cleanup. RTP/RTCP PCM helper используют IPv4 loopback; доступность ICE/STUN/TURN для peers — отдельная ответственность приложения.

## Browser WebRTC

Отдельный browser-safe импорт использует **`@hyperttp/transport-webrtc/browser`** и нативные `RTCPeerConnection`/`MediaStream`, без FFmpeg, Werift и native Opus/DAVE:

```ts
import { createBrowserWebRtcAudio } from "@hyperttp/voice/browser";

const audio = createBrowserWebRtcAudio({ iceServers: [] });
const offTrack = audio.transport.onTrack(({ stream }) => {
  audioElement.srcObject = stream; // существующий HTMLAudioElement
});

// Вызывайте из пользовательского действия; autoplay может требовать отдельный play().
try {
  await audio.transport.execute({
    url: "https://your-signaling-server.example/signal",
    method: "POST",
    headers: {},
    protocol: "webrtc",
    receiveAudio: true,
    // Для передачи микрофона: localStream: await navigator.mediaDevices.getUserMedia({ audio: true })
  });
  await audioElement.play();
} catch (error) {
  offTrack();
  await audio.close();
  throw error;
}
// При завершении UI: offTrack(); await audio.close(); audioElement.srcObject = null;
// Если получали микрофон: самостоятельно вызовите stop() на его tracks.
```

Можно импортировать сам `WebRtcTransport` и его публичные типы из того же подпути. Существующий Hyperttp transport реализует SDP/ICE signaling и request/response через DataChannel: сервер должен поддерживать его POST/DELETE `/signal` и DataChannel-контракт; произвольный WebRTC endpoint не подойдёт. Без `iceServers` используется upstream STUN по умолчанию; настройте STUN/TURN для своей сети.

Это **обычный WebRTC, не Discord Voice** и не browser PCM framer. Browser encoder/pacing уже входят в WebRTC stack. Локальные MediaStream tracks принадлежат вызывающему коду, `close()` их не останавливает.

`HyperClient` намеренно не импортируется в browser entry: `hyperttp@0.6.2` с `@hyperttp/core@2.0.5` подтягивает `node:http`, что ломает browser bundle. Проверена browser-сборка esbuild и lifecycle без сессий; реальное воспроизведение/микрофон в браузере ещё не проверены. Для browser-кода используйте именно `/browser`, не корневой Node entry point.

## Кэш метаданных

Публичный контракт runtime: `createMetadataCache<T>({ ttl?, maxSize? })`, реализация на `hcacher` (TTL в миллисекундах). Это кэш метаданных, **не аудиокадров и не бесконечных PCM-очередей**. Пример после подключения экспорта:

```ts
import { createMetadataCache } from "@hyperttp/voice";
const metadata = createMetadataCache<{ title: string }>({ ttl: 60_000, maxSize: 100 });
metadata.set("track:1", { title: "Музыка" });
const track = metadata.get("track:1");
```

## Benchmark и opt-in smoke

После сборки, на Node 26 с встроенным TypeScript stripping:

```sh
node benchmarks/audio.ts
BENCH_FRAMES=250 node benchmarks/audio.ts
node scripts/discord-smoke.ts
```

Benchmark импортирует **`dist/index.js`**, сравнивает paced PCM→native Opus и готовые Opus packets на in-process sink. Выводит wall time, CPU user/system и загрузку одного ядра отдельно от снимков памяти, а также `monitorEventLoopDelay` (mean/p99/max в миллисекундах). Это не network throughput, peak memory или доказательство отсутствия утечек; GC, JIT и порядок прогонов влияют на результат.

Smoke по умолчанию пропускается. Для реального подключения необходимо явно установить `VOICE_SMOKE=1` и все переменные:

- `VOICE_GUILD_ID`, `VOICE_CHANNEL_ID`, `VOICE_USER_ID`;
- `VOICE_SESSION_ID`, `VOICE_TOKEN`, `VOICE_ENDPOINT` — свежие параметры **voice session**, не bot token.

Затем запустить `node scripts/discord-smoke.ts` в том же окружении. Скрипт не выполняет Gateway join: приложение должно уже получить действительную сессию и оставаться в канале. Он кодирует и отправляет пять секунд тихого тона 440 Hz через runtime и пять завершающих silence-пакетов, требует DAVE, ограничивает время и освобождает ресурсы в `finally`. Секреты и server errors не логируются. Успех отправки не доказывает слышимость на удалённом клиенте. Не помещайте секреты в репозиторий/историю shell.

## Ограничения и безопасность

- Discord transport поддерживает **только `aead_aes256_gcm_rtpsize`**. XChaCha20 и старые режимы не поддерживаются; fallback нет.
- DAVE обязателен по умолчанию (`requireDave: true`), ошибки обрабатываются **fail closed**. `requireDave: false` явно разрешает transport-only при версии 0, но не исправляет сломанную MLS-сессию.
- Нет Discord session resume или автоматического reconnect. После разрыва приложение явно вызывает `disconnect()`/`connect()` либо создаёт новый адаптер со свежей сессией. После `destroy()` адаптер не переиспользуется.
- Это sender-oriented API, не полноценный Discord bot framework/receive stack.
- У native Opus binding нет `destroy()`: `close()` снимает JS-ссылку для native GC, не обещает немедленное освобождение RSS. DAVE cleanup вызывает `reset()` и снимает ссылку.
- **Live production-тест Discord не проводился.** Unit/fixture-тесты и локальный FFmpeg bridge не подтверждают совместимость с реальным сервером, переходами участников и длительными reconnect-сценариями.

Версии, источники и границы проверок: [`docs/research.md`](docs/research.md).
