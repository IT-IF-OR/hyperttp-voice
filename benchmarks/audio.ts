import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { createOpusCodec, createVoiceRuntime, PCM_FRAME_BYTES } from "../dist/index.js";

const frames = Number(process.env.BENCH_FRAMES ?? 100);
if (!Number.isSafeInteger(frames) || frames < 1 || frames > 30_000) {
  throw new Error("BENCH_FRAMES must be an integer in 1..30000");
}

const pcm = Buffer.alloc(PCM_FRAME_BYTES);
for (let i = 0; i < 960; i++) {
  const sample = Math.round(Math.sin((2 * Math.PI * 440 * i) / 48_000) * 4000);
  pcm.writeInt16LE(sample, i * 4);
  pcm.writeInt16LE(sample, i * 4 + 2);
}
const codec = createOpusCodec({ channels: 2, bitrate: 96_000 });
let opus: Buffer;
try {
  opus = codec.encode(pcm);
  if (codec.decode(opus).length !== PCM_FRAME_BYTES) throw new Error("Invalid decoded frame");
} finally {
  codec.close();
}

async function* source(packet: Buffer) {
  for (let i = 0; i < frames; i++) yield packet;
}

async function measure(format: "pcm" | "opus") {
  let packets = 0;
  let bytes = 0;
  const runtime = createVoiceRuntime(
    {
      sendOpus(packet: Buffer) {
        packets++;
        bytes += packet.length;
      },
    },
    { channels: 2, bitrate: 96_000, diagnostics: true },
  );
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  await delay(30);
  histogram.reset();
  const memoryBefore = process.memoryUsage();
  const cpuBefore = process.cpuUsage();
  const start = performance.now();
  try {
    await runtime.play(
      source(format === "pcm" ? pcm : opus),
      format === "pcm" ? { format: "pcm" } : { format: "opus", samples: 960 },
    );
    const wallMs = performance.now() - start;
    const cpu = process.cpuUsage(cpuBefore);
    const memoryAfter = process.memoryUsage();
    histogram.disable();
    console.log(
      JSON.stringify(
        {
          format,
          frames: packets,
          bytes,
          wallMs,
          cpu: {
            userMs: cpu.user / 1000,
            systemMs: cpu.system / 1000,
            oneCorePercent: ((cpu.user + cpu.system) / 1000 / wallMs) * 100,
          },
          memory: {
            before: memoryBefore,
            after: memoryAfter,
            rssDeltaBytes: memoryAfter.rss - memoryBefore.rss,
            heapUsedDeltaBytes: memoryAfter.heapUsed - memoryBefore.heapUsed,
          },
          eventLoopDelayMs: histogram.count
            ? {
                mean: histogram.mean / 1e6,
                p99: histogram.percentile(99) / 1e6,
                max: histogram.max / 1e6,
              }
            : null,
          diagnostics: runtime.diagnostics,
        },
        null,
        2,
      ),
    );
  } finally {
    histogram.disable();
    await runtime.destroy();
  }
}

console.log(
  JSON.stringify({
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    note: "Paced 20ms runtime, in-process sink; not a Discord/WebRTC network throughput test",
  }),
);
await measure("pcm");
await measure("opus");
