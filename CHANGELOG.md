# Changelog

# All notable changes to @hyperttp/voice are documented here. Versions are listed in reverse chronological order.

## [0.2.9] - 2026-11-24

### Changed

- Updated the hyperttp dependency to ^0.7.10.

## [0.2.8] - 2026-11-24

### Changed

- Updated the hyperttp dependency to ^0.7.9.

## [0.2.7] - 2026-11-24

### Changed
- Updated @hyperttp/protocol-webrtc to ^0.3.2 and @hyperttp/transport-webrtc to ^0.4.6.
- Updated hyperttp to ^0.7.6, @hyperttp/types peer dependency to ^0.5.5, and discord-api-types to 0.38.60.
- Updated the WebRTC server signaling integration to use the transport-created WebRtcSignalingHandler and the current onRequest contract.
- Added a dedicated tsconfig.build.json; the regular TypeScript configuration now type-checks source and tests, while the build configuration emits only package source files.
- Updated the formatting and linting toolchain.

## [0.2.6] - 2026-11-20

### Changed

- Updated @hyperttp/transport-webrtc to ^0.4.5.
- Updated development tooling, including Bun types, Vitest, coverage, Oxfmt, and Oxlint.

## [0.2.5] - 2026-11-13

### Added
- Added audio.createRestSignaling(...) to integrate WebRTC signaling with an existing HyperServer without creating another HTTP listener or WebRTC transport.
- Exposed the signaling handler and a REST route adapter. Register the route for POST, GET, PATCH, and DELETE on the existing server.
- Added coverage for creating the REST signaling route without opening an additional listener.
Changed
- Documented authorization and shutdown requirements for applications that host signaling through an existing REST server.

## [0.2.4] - 2026-11-13

### Added

- Added WebRTC audio diagnostics for active PCM subscriptions, server-session subscriptions, and client subscription state.

### Changed

- Made the client-side PCM subscription lazy: accessing server-only functionality no longer creates a client MediaStreamTrack subscription.
- Reuse an existing PCM subscription when the same server session requests its local stream again.
- Avoided unnecessary Buffer.from(...) copies around native Opus encode/decode results; normalize incoming PCM chunks only when they are not already Node.js buffers.
- Updated @hyperttp/protocol-webrtc to ^0.3.1, @hyperttp/transport-webrtc to ^0.4.4, discord-api-types to 0.38.59, and hyperttp to ^0.7.5.

## [0.2.3] - 2026-11-12

### Changed

- Updated @hyperttp/transport-webrtc to ^0.4.2.
- Updated discord-api-types to 0.38.58, hcacher to ^0.3.1, and hemmiter to ^0.1.1.
- Moved @dirold2/dev-tools to development dependencies and refreshed formatting/linting tools.

## [0.2.2] - 2026-11-06

### Added

- Added a real trickle-ICE integration test for the WebRTC audio adapter, using a local signaling/transport setup and checking Opus delivery when FFmpeg with libopus is available.
- Added the pub and dist package scripts.

### Changed

- Replaced the shared build-script invocation with an explicit TypeScript, esbuild minification/source-map, and d-build pipeline.
- Updated @hyperttp/protocol-webrtc to ^0.3.0 and @hyperttp/transport-webrtc to ^0.4.0.
- Updated @snazzah/davey to ^0.2.0 and refreshed Discord.js and development dependencies.

## [0.2.1] - 2026-11-03

### Added
- Added the typed audio.server(options) facade for configuring a WebRTC server with application-owned services and dependency injection.
- Added server-side WebRTC signaling registration with authorization and lifecycle management; the listener is started explicitly and is closed with the audio adapter.

### Changed
- Improved DAVE MLS transition handling by separating key preparation from transition execution. The adapter does not report itself ready or send with new keys until the corresponding gateway transition has executed.
- Made connection readiness wait for both transport setup and DAVE readiness, with transition state tracked explicitly.
- Updated @hyperttp/transport-webrtc to ^0.3.0 and hyperttp to ^0.7.4.
- Updated the WebRTC PCM example to check the returned response status and fail on an unsuccessful stream request.

## [0.2.0] - 2026-11-03

### Added
- Added the WebRTC server facade on top of HyperClient, including typed server options and application-service injection.
- Added the default WebRTC control handler for the connect/stream flow, while retaining support for a custom handler.
- Added tests for server service injection, early signaling authorization, and listener cleanup.

### Changed
- Strengthened DAVE MLS handling so a transition is prepared and then executed at the corresponding gateway event; unprepared commits now fail explicitly.
- Updated Hyperttp/WebRTC dependencies and aligned the package build with the repository's build tooling.

## [0.1.1]–[0.1.9]
- No separate release commits or version tags for these patch versions are present in the available GitHub repository history. The earliest available project commit is the initial 0.1.0 commit; changes for the unrecorded patch releases are therefore not listed rather than being inferred.
