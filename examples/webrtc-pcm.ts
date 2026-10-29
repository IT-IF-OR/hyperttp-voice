import { createReadStream } from "node:fs";
import { createWebRtcAudio } from "@hyperttp/voice/webrtc";

/** peerUrl — реальный адрес signaling получателя, обслуживаемый Hyperttp WebRTC. */
export async function streamPcmToPeer(
  pcmPath: string,
  peerUrl: string,
  signal?: AbortSignal,
): Promise<void> {
  const input = createReadStream(pcmPath);
  try {
    // Требуется внешний FFmpeg с libopus; вход: raw 48 kHz stereo s16le.
    const audio = await createWebRtcAudio(input, signal ? { signal } : {});
    try {
      // Реальный HyperClient; signaling/ICE и доступность получателя настраивает приложение.
      await audio.client.webrtc.stream(peerUrl, audio.stream);
      await audio.done;
    } finally {
      await audio.close();
    }
  } finally {
    input.destroy();
  }
}
