# Исследование API и границы проверок

## Среда и установленные версии

Проверено по реальным `node_modules/*/package.json`, декларациям и `src`, а не только диапазонам зависимостей:

| Компонент                    | Версия                   |
| ---------------------------- | ------------------------ |
| ОС / архитектура             | Linux x64                |
| Node.js                      | 26.12.0                  |
| Bun                          | 1.4.3                    |
| FFmpeg                       | n9.0.2, сборка с libopus |
| hyperttp                     | 0.6.2                    |
| @hyperttp/core (транзитивно) | 2.0.5                    |
| @hyperttp/protocol-webrtc    | 0.1.1                    |
| @hyperttp/transport-webrtc   | 0.1.1                    |
| @hyperttp/types              | 0.4.2                    |
| werift                       | 0.25.2                   |
| libopus-node                 | 1.3.1                    |
| @snazzah/davey               | 0.1.12                   |
| hcacher                      | 0.3.0                    |
| hemmiter                     | 0.1.0                    |
| TypeScript / Vitest          | 7.0.2 / 5.0.5            |

`libopus-node` требует Node >=24, хотя engines проекта пока >=20. Наличие prebuild для этой Linux x64 среды не гарантирует поддержку всех ОС/libc/архитектур.

## Реальные API и владение ресурсами

- `src/audio.ts`: `framePcm` принимает async iterable/Web ReadableStream, 48 kHz s16le, 960 samples/channel; stereo 3840 bytes, mono 1920 bytes. Tail pad/error и проверка целого interleaved sample — разные проверки. Стандартный chunk limit 1 MiB. Отмена запрашивает `iterator.return()`/`reader.cancel()`, но произвольный producer обязан сотрудничать.
- `src/runtime.ts`: `createVoiceRuntime(sink, options)` возвращает paced player; `sink.sendOpus(Buffer, samples?)`. PCM по умолчанию, готовый Opus требует `{ format: "opus", samples: 960 }`. Runtime владеет codec, включая созданный `codecFactory`. Pause/resume относится к воспроизведению, не Discord session resume.
- `src/codec.ts` и установленный `libopus-node/dist/index.d.ts`: `OpusEncoder(48000, channels)`, `encode`, `decode`, `setBitrate`. **Native destroy API нет**: wrapper `close()` снимает ссылку, дальнейшие вызовы запрещены; немедленная деаллокация native memory не гарантируется.
- `src/discord.ts`: `VoiceGateway` — структурный интерфейс `send`, `on("dispatch", listener)`, `off`. Join выполняется через op 4 и пару dispatch событий; альтернатива — готовая `session: { sessionId, token, endpoint }`. Это не реализация bot Gateway login. `connect()` ждёт transport Session Description, не обязательно MLS-ready. `sendOpus()` до готовности DAVE завершается ошибкой и закрывает попытку.
- `src/dave.ts`: реальный `DAVESession` из Davey, key packages/MLS transitions и `encryptOpus`; DAVE обязателен по умолчанию, version 0 отвергается. Нет fallback при native/протокольной ошибке. `destroy()` wrapper вызывает native `reset()` и снимает ссылку; не выдумывает native `destroy()`.
- `src/rtp.ts`: только `aead_aes256_gcm_rtpsize`, nonce counter и RTP header authentication; это transport encryption, отдельный слой от DAVE. Не XChaCha20/XSalsa20.
- `src/webrtc.ts`: `new HyperClient(config, transport)` из `hyperttp`, автоматический WebRTC protocol (явный `createWebRtcProtocol` только для custom handler), реальный `WebRtcTransport`. Не mock transport. `createPcmAudioSource` импортируется из установленного `/pcm-audio`. Внешний FFmpeg с libopus обязателен именно здесь. Один live encoder, независимые subscriptions без replay, PCM только raw 48 kHz stereo s16le; FFmpeg обеспечивает pacing. `audio.client.webrtc.stream(peerUrl, audio.stream)` — фактический клиентский API. EOF/ошибка/abort закрывают source/core/subscriptions; приложение предоставляет signaling endpoint и сеть/ICE.
- `hcacher@0.3.0` экспортирует runtime `CacheManager<T>`, его опции содержат `ttl` (мс) и `maxSize`. Согласованный wrapper API — `createMetadataCache<T>({ ttl?, maxSize? })`, для метаданных, не audio buffering.

При проверке `src/index.ts` был пуст, metadata wrapper ещё отсутствовал, exports map содержал только корень. Корневые re-exports audio/runtime/codec/discord/dave/rtp, wrapper и subpath `/webrtc` должны быть добавлены владельцем исходников. Документация и примеры ориентированы на этот контракт; ни `src`, ни `package.json` в этой задаче не редактировались.

## Что действительно запущено

1. Прямой native probe на **Node 26.12.0 и Bun 1.4.3**: `OpusEncoder` кодирует 3840 bytes PCM и декодирует обратно в 3840 bytes; `DAVESession(DAVE_PROTOCOL_VERSION, userId, channelId)` создаёт непустой serialized key package. Оба прогона успешны. Длина key package различалась; это нормально и не является golden fixture.
2. `npm run typecheck` — успешно для исходников текущего проекта.
3. `node node_modules/vitest/vitest.mjs run tests/codec.test.ts tests/dave.test.ts` — **29 tests passed, 2 files passed** на Node. Предупреждение Vite о будущем native config loader не меняло результат.
4. `node scripts/discord-smoke.ts` без `VOICE_SMOKE=1` — корректный skip, без сетевого подключения.
5. Typecheck четырёх новых `.ts` файлов через TypeScript 7 с `--ignoreConfig` выявил ожидаемый интеграционный блокер: пустой корневой экспорт и отсутствующий `/webrtc`. Полную компиляцию примеров нельзя считать прошедшей до подключения экспортов. Сами вызовы сверены с исходными сигнатурами и декларациями установленных зависимостей.
6. Исходники скомпилированы `node node_modules/typescript/bin/tsc`; это не запуск полного release pipeline `npm run build`. Benchmark импортирует собранный `dist/index.js`, поэтому полноценный benchmark до корневых экспортов не подтверждён.

**Не запускались:** live Discord production smoke, вся Bun network suite, длительные soak/reconnect тесты и межплатформенная матрица. Успешный native probe не доказывает работоспособность Bun WebSocket/dgram/таймеров во всех протокольных сценариях.

## Fixtures и пределы выводов

`tests/codec.test.ts` использует реальные native encode/decode. `tests/dave.test.ts` проверяет native key package и сценарии протокола; тестовые signaling payloads/подменённые MLS операции не являются записью реального production обмена. Непустой key package не доказывает успешный MLS handshake или end-to-end совместимость с Discord.

В `tests/discord.test.ts`, `tests/rtp.test.ts`, `tests/runtime.test.ts`, `tests/audio.test.ts` есть локальные проверки; наличие файлов не означает, что все они запускались в этом проходе. `tests/webrtc.test.ts` содержит реальные FFmpeg/loopback integration tests с условным skip без encoder. Их наличие не равно успешной проверке реального peer через публичную сеть, STUN/TURN или production signaling.

Discord поддерживает только явный reconnect, без session resume/автоматического восстановления. `destroy()` терминален. Обновление сессии/сервера, восстановление Gateway и политика повторов принадлежат приложению. `requireDave: false` — явное ослабление требований при версии 0, не автоматическая деградация.

Benchmark — paced runtime на in-process sink, не максимальная производительность сети: PCM encoding и Opus passthrough измеряются отдельно. `monitorEventLoopDelay` возвращает наносекунды (перевод в мс); CPU user/system — микросекунды (перевод в мс); память — отдельные before/after снимки в байтах, не peak/leak detector. Освобождение native ссылок и изменение RSS не обязаны совпадать по времени.

## Источники

Первичны локальные `src/*.ts`, перечисленные выше, `package.json`, lockfile, установленные `node_modules/*/package.json` и `.d.ts`. Внешние материалы — контекст протокола, а не доказательство прогона:

- [Discord Voice Connections](https://discord.com/developers/docs/topics/voice-connections)
- [Discord DAVE protocol](https://github.com/discord/dave-protocol)
- [Davey](https://github.com/Snazzah/davey)
- [libopus-node](https://github.com/biw/libopus-node)
- [Hyperttp core](https://github.com/IT-IF-OR/hyperttp-core)
- [Hyperttp WebRTC transport](https://github.com/IT-IF-OR/hyperttp-transport-webrtc)
- [hcacher](https://github.com/dirold2/hcacher)
- [Node perf_hooks](https://nodejs.org/api/perf_hooks.html#perf_hooksmonitoreventloopdelayoptions), [process CPU/memory](https://nodejs.org/api/process.html), [TypeScript stripping](https://nodejs.org/api/typescript.html)
- [FFmpeg documentation](https://ffmpeg.org/ffmpeg.html)
