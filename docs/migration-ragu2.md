# Поэтапная миграция ragu2

## Готовность и криптографические переходы

`await voice.connect(signal)` завершается только после UDP/transport handshake **и** готовности DAVE MLS sender keys и соответствующего gateway execute. Дедлайн `timeoutMs` покрывает весь handshake. `ready` не означает только наличие transport key.

Во время смены эпох `sendOpus` ожидает готовность DAVE, сохраняя backpressure. Ожидание ограничено `timeoutMs`, отменяется при disconnect/destroy или переданном `AbortSignal`. Параллельные send отклоняются: адаптер не накапливает очередь. Runtime передаёт свой сигнал, поэтому stop не оставляет отложенный пакет, который отправится после возобновления MLS.

Runtime при EOF/stop/abort завершает передачу через необязательный `AudioSink.endTransmission()`. Discord отправляет пять silence-пакетов с интервалом 20 мс через оба слоя шифрования, затем speaking=0. Повторное завершение идемпотентно. При утрате соединения tail не гарантируется. Во время pause аудио не читается/не передаётся; tail отправляется при окончательном завершении, не при pause.

## Переключатель backend

В текущем рабочем дереве ragu2 уже есть `AudioOutputFactory`. Рекомендуемый параметр запуска:

```sh
VOICE_BACKEND=discordjs # безопасное значение по умолчанию
VOICE_BACKEND=hyperttp # opt-in в тестовом окружении
```

Это **план интеграции**, а не уже добавленная переменная voice-пакета или ragu2. Сам пакет не читает `VOICE_BACKEND`.

Точки интеграции ragu2:

- `src/modules/discord/audio/DiscordAudioOutputRegistry.ts`: выбрать реализацию, хранить общий `AudioOutput` с методом connect.
- Новая `HyperttpAudioOutput`: обернуть `DiscordVoiceAdapter` + `createVoiceRuntime`, сохранив контракт `src/services/player/AudioOutput.ts`.
- `src/modules/discord/DiscordTransportModule.ts` и `src/main.ts`: передать проверенную настройку backend.
- Существующий `DiscordAudioOutput.ts` и зависимость `@discordjs/voice` оставить.
- Gateway bridge должен отправлять op=4 через shard соответствующей guild и передавать raw dispatch `VOICE_STATE_UPDATE`/`VOICE_SERVER_UPDATE`; не создавать второй bot Gateway.
- Существующий поток PCM 48 kHz stereo s16le передавать в `runtime.play(stream)`, без дополнительного FFmpeg/Opus-прохода.

`play`/`stop` в ragu2 синхронные, а runtime асинхронный: wrapper обязан сериализовать stop → новый play и отсекать устаревшие операции. Сохранить проверки прав, leave/idle timers, настройки selfDeaf и async destroy. Не переключать backend посреди живой сессии без полного teardown. Автоматический fallback не реализован; безопасный rollback — перезапуск с discordjs.

## Обязательная проверка в тестовой guild

Обычные тесты не подключаются к Discord. Opt-in `npm run smoke:discord` требует `VOICE_SMOKE=1` и свежие `VOICE_GUILD_ID`, `VOICE_CHANNEL_ID`, `VOICE_USER_ID`, `VOICE_SESSION_ID`, `VOICE_TOKEN`, `VOICE_ENDPOINT`. Внешнее приложение должно уже владеть активной Gateway voice session; скрипт не логинит бота. Не сохраняйте значения в git и логах.

Скрипт ждёт DAVE-ready и отправляет тихий тон 440 Hz пять секунд, затем silence tail. Успешный UDP send не доказывает слышимость — нужен слушатель.

Перед включением hyperttp по умолчанию проверить:

- слышимый звук при немедленном play после connect;
- вход/выход второго участника во время воспроизведения, смену MLS-эпох без разрыва;
- pause/resume, stop, новый трек и отсутствие старых пакетов;
- disconnect/destroy во время handshake и смены эпох;
- сетевой разрыв и явный disconnect → connect → новый play;
- длительное воспроизведение, память и event-loop delay;
- откат к discordjs без двух соединений одной guild.

Автоматический reconnect/resume Voice Gateway пока отсутствует. AES-GCM RTP-size — единственный transport mode. Локальные native/sockets тесты не заменяют эти live проверки.
