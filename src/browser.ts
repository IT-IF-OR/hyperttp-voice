import { WebRtcTransport, type WebRtcTransportOptions } from "@hyperttp/transport-webrtc/browser";

export { WebRtcTransport } from "@hyperttp/transport-webrtc/browser";
export type {
  WebRtcTransportOptions,
  WebRtcTransportRequest,
  WebRtcTrackEvent,
  WebRtcSessionView,
} from "@hyperttp/transport-webrtc/browser";

export interface BrowserWebRtcAudio {
  readonly transport: WebRtcTransport;
  /** Closes peer sessions. Caller-owned local MediaStream tracks are not stopped. */
  close(): Promise<void>;
}

/**
 * Native browser media path; encoding and pacing belong to the browser.
 * No HyperClient import: hyperttp 0.6.2/core 2.0.5 pull node:http into browser bundles.
 */
export function createBrowserWebRtcAudio(options: WebRtcTransportOptions = {}): BrowserWebRtcAudio {
  const transport = new WebRtcTransport(options);
  let closing: Promise<void> | undefined;
  return {
    transport,
    close() {
      closing ??= transport.close();
      return closing;
    },
  };
}
