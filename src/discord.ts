import {
  GatewayOpcodes,
  GatewayDispatchEvents,
  type GatewayVoiceStateUpdate,
} from "discord-api-types/v10";
import {
  VoiceOpcodes,
  VoiceGatewayVersion,
  VoiceSpeakingFlags,
  type VoiceSendPayload,
} from "discord-api-types/voice/v8";
import { createSocket, type Socket } from "node:dgram";
import { isIP } from "node:net";
import { MiniEmitter } from "hemmiter";
import { DaveAdapter } from "./dave.js";
import {
  DISCORD_ENCRYPTION_MODE,
  RtpSender,
  discoveryRequest,
  parseDiscoveryResponse,
  OPUS_SILENCE,
} from "./rtp.js";

type OutgoingVoicePayload =
  | Exclude<VoiceSendPayload, { op: VoiceOpcodes.Speaking }>
  | {
      op: VoiceOpcodes.Speaking;
      // 0 clears speaking; discord-api-types 0.38.57 omits the empty flag set.
      d: Omit<Extract<VoiceSendPayload, { op: VoiceOpcodes.Speaking }>["d"], "speaking"> & {
        speaking: VoiceSpeakingFlags | 0;
      };
    };

export interface VoiceSession {
  sessionId: string;
  token: string;
  endpoint: string;
}
export interface GatewayDispatch {
  t: string;
  d: unknown;
}
export interface VoiceGateway {
  send(payload: GatewayVoiceStateUpdate): void;
  on(event: "dispatch", listener: (payload: GatewayDispatch) => void): unknown;
  off(event: "dispatch", listener: (payload: GatewayDispatch) => void): unknown;
}
export interface DiscordVoiceOptions {
  guildId: string;
  channelId: string;
  userId: string;
  session?: VoiceSession;
  gateway?: VoiceGateway;
  requireDave?: boolean;
  timeoutMs?: number;
  selfDeaf?: boolean;
  selfMute?: boolean;
}
export type DiscordVoiceState = "disconnected" | "connecting" | "ready" | "destroyed";
export type DiscordVoiceEvents = {
  stateChange: [state: DiscordVoiceState];
  ready: [];
  disconnect: [reason: Error | undefined];
  error: [error: Error];
};
interface Attempt {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
  cleanup: Array<() => void>;
  ws?: WebSocket;
  udp?: Socket;
  dave?: DaveAdapter;
  rtp?: RtpSender;
  ssrc?: number;
  selected: boolean;
  speaking: boolean;
  seq: number;
  controller: AbortController;
  sending: boolean;
  ending: Promise<void> | undefined;
}
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Expected protocol object");
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Invalid ${name}`);
  return value;
}
function integer(value: unknown, max: number, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max)
    throw new Error(`Invalid ${name}`);
  return value;
}
function errorOf(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** Encoded Opus sink; framing, pacing, and audio encoding belong to the caller. */
export class DiscordVoiceAdapter extends MiniEmitter<DiscordVoiceEvents> {
  private attempt: Attempt | undefined;
  private currentState: DiscordVoiceState = "disconnected";
  readonly options: Readonly<DiscordVoiceOptions>;

  constructor(options: DiscordVoiceOptions) {
    super();
    if (!options.gateway && !options.session)
      throw new Error("A voice session or Gateway is required");
    for (const name of ["guildId", "channelId", "userId"] as const) text(options[name], name);
    if (
      options.timeoutMs !== undefined &&
      (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
    )
      throw new Error("Invalid connection timeout");
    this.options = { ...options };
  }
  get state(): DiscordVoiceState {
    return this.currentState;
  }
  get connected(): boolean {
    return this.state === "ready";
  }
  get daveVersion(): number {
    return this.attempt?.dave?.version ?? 0;
  }
  private stateTo(state: DiscordVoiceState): void {
    this.currentState = state;
    this.emit("stateChange", state);
  }
  private active(a: Attempt): boolean {
    return this.attempt === a;
  }

  connect(signal?: AbortSignal): Promise<void> {
    if (this.state === "destroyed") return Promise.reject(new Error("Voice adapter is destroyed"));
    if (signal?.aborted)
      return Promise.reject(errorOf(signal.reason ?? new Error("Connection aborted")));
    if (this.attempt) return this.attempt.promise;
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const a: Attempt = {
      promise,
      resolve,
      reject,
      cleanup: [],
      selected: false,
      speaking: false,
      seq: -1,
      controller: new AbortController(),
      sending: false,
      ending: undefined,
    };
    this.attempt = a;
    const timer = setTimeout(
      () => this.fail(a, new Error("Voice connection timed out")),
      this.options.timeoutMs ?? 15000,
    );
    a.cleanup.push(() => clearTimeout(timer));
    if (signal) {
      const abort = () => this.fail(a, errorOf(signal.reason ?? new Error("Connection aborted")));
      signal.addEventListener("abort", abort, { once: true });
      a.cleanup.push(() => signal.removeEventListener("abort", abort));
    }
    this.stateTo("connecting");
    if (!this.active(a)) return promise;
    try {
      if (this.options.session) this.open(a, this.options.session);
      else this.join(a);
    } catch (error) {
      this.fail(a, errorOf(error));
    }
    return promise;
  }

  private join(a: Attempt): void {
    const gateway = this.options.gateway!;
    let sessionId: string | undefined;
    let server: { token: string; endpoint: string } | undefined;
    let opened = false;
    const dispatch = (event: GatewayDispatch) => {
      if (!this.active(a)) return;
      try {
        if (
          event.t !== GatewayDispatchEvents.VoiceStateUpdate &&
          event.t !== GatewayDispatchEvents.VoiceServerUpdate
        )
          return;
        const d = object(event.d);
        if (d.guild_id !== this.options.guildId) return;
        if (event.t === GatewayDispatchEvents.VoiceStateUpdate) {
          if (d.user_id !== this.options.userId) return;
          if (d.channel_id !== this.options.channelId) {
            if (opened) throw new Error("Gateway moved or disconnected the voice client");
            return;
          }
          const next = text(d.session_id, "session_id");
          if (opened && next !== sessionId)
            throw new Error("Voice session changed; reconnect explicitly");
          sessionId = next;
        } else {
          if (opened) throw new Error("Voice server changed; reconnect explicitly");
          if (d.endpoint === null) {
            server = undefined;
            return;
          }
          server = { token: text(d.token, "token"), endpoint: text(d.endpoint, "endpoint") };
        }
        if (!opened && sessionId && server) {
          opened = true;
          this.open(a, { sessionId, ...server });
        }
      } catch (error) {
        this.fail(a, errorOf(error));
      }
    };
    gateway.on("dispatch", dispatch);
    a.cleanup.push(() => {
      gateway.off("dispatch", dispatch);
      gateway.send({
        op: GatewayOpcodes.VoiceStateUpdate,
        d: {
          guild_id: this.options.guildId,
          channel_id: null,
          self_mute: false,
          self_deaf: this.options.selfDeaf ?? true,
        },
      });
    });
    gateway.send({
      op: GatewayOpcodes.VoiceStateUpdate,
      d: {
        guild_id: this.options.guildId,
        channel_id: this.options.channelId,
        self_mute: this.options.selfMute ?? false,
        self_deaf: this.options.selfDeaf ?? true,
      },
    });
  }

  private open(a: Attempt, session: VoiceSession): void {
    text(session.sessionId, "sessionId");
    text(session.token, "token");
    const endpoint = text(session.endpoint, "endpoint");
    const url = new URL(endpoint.includes("://") ? endpoint : `wss://${endpoint}`);
    if (url.protocol !== "wss:" && url.protocol !== "ws:")
      throw new Error("Invalid voice endpoint protocol");
    url.searchParams.set("v", VoiceGatewayVersion);
    const ws = new WebSocket(url);
    a.cleanup.push(() => {
      // A locally cancelled CONNECTING socket reports an expected asynchronous error.
      ws.addEventListener("error", () => {}, { once: true });
      ws.close();
    });
    a.ws = ws;
    ws.binaryType = "arraybuffer";
    a.dave = new DaveAdapter(
      this.options.userId,
      this.options.channelId,
      (op, data) => this.sendJson(a, op, data),
      (op: number, payload: Buffer) => {
        if (!this.active(a) || ws.readyState !== WebSocket.OPEN)
          throw new Error("Voice WebSocket is not open");
        ws.send(Buffer.concat([Buffer.from([op]), payload]));
      },
      this.options.requireDave === undefined ? {} : { requireDave: this.options.requireDave },
    );
    const onOpen = () => {
      if (!this.active(a)) return;
      try {
        this.sendJson(a, VoiceOpcodes.Identify, {
          server_id: this.options.guildId,
          user_id: this.options.userId,
          session_id: session.sessionId,
          token: session.token,
          max_dave_protocol_version: a.dave!.maxProtocolVersion,
        });
      } catch (error) {
        this.fail(a, errorOf(error));
      }
    };
    const onMessage = (event: MessageEvent<unknown>) => {
      if (!this.active(a)) return;
      try {
        if (event.data instanceof ArrayBuffer) {
          const bytes = Buffer.from(event.data);
          if (bytes.length < 3) throw new Error("Truncated binary voice message");
          a.seq = bytes.readUInt16BE(0);
          a.dave!.handleBinary(bytes[2]!, bytes.subarray(3));
        } else if (typeof event.data === "string") {
          const message = object(JSON.parse(event.data) as unknown);
          if (message.seq !== undefined) a.seq = integer(message.seq, 0xffff, "sequence");
          this.message(a, integer(message.op, 255, "opcode"), message.d);
        } else throw new Error("Unsupported voice message format");
      } catch (error) {
        this.fail(a, errorOf(error));
      }
    };
    const onError = () => this.fail(a, new Error("Voice WebSocket transport error"));
    const onClose = (event: CloseEvent) =>
      this.fail(a, new Error(`Voice WebSocket closed (${event.code}): ${event.reason}`));
    ws.addEventListener("open", onOpen);
    ws.addEventListener("message", onMessage);
    ws.addEventListener("error", onError);
    ws.addEventListener("close", onClose);
    a.cleanup.push(() => {
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("error", onError);
      ws.removeEventListener("close", onClose);
    });
  }

  private sendJson<Op extends OutgoingVoicePayload["op"]>(
    a: Attempt,
    op: Op,
    d: Extract<OutgoingVoicePayload, { op: Op }>["d"],
  ): void {
    if (!this.active(a) || a.ws?.readyState !== WebSocket.OPEN)
      throw new Error("Voice WebSocket is not open");
    a.ws.send(JSON.stringify({ op, d }));
  }
  private message(a: Attempt, op: number, data: unknown): void {
    if (op === VoiceOpcodes.Hello) {
      const interval = integer(object(data).heartbeat_interval, 0x7fffffff, "heartbeat interval");
      if (interval === 0) throw new Error("Invalid heartbeat interval");
      let pending: number | undefined;
      const beat = () => {
        if (!this.active(a)) return;
        try {
          if (pending !== undefined) throw new Error("Voice heartbeat ACK timed out");
          pending = Date.now();
          this.sendJson(a, VoiceOpcodes.Heartbeat, { t: pending, seq_ack: a.seq });
        } catch (error) {
          this.fail(a, errorOf(error));
        }
      };
      // Bind ACK handling to this heartbeat generation.
      const ack = (value: unknown) => {
        if (object(value).t === pending) pending = undefined;
      };
      if (this.acks.has(a)) throw new Error("Duplicate voice Hello");
      this.acks.set(a, ack);
      const timer = setInterval(beat, Math.min(interval, 5000));
      a.cleanup.push(() => {
        clearInterval(timer);
        this.acks.delete(a);
      });
      beat();
    } else if (op === VoiceOpcodes.HeartbeatAck) {
      this.acks.get(a)?.(data);
    } else if (op === VoiceOpcodes.Ready) {
      if (a.udp) throw new Error("Duplicate voice Ready");
      const d = object(data);
      if (!Array.isArray(d.modes) || !d.modes.includes(DISCORD_ENCRYPTION_MODE))
        throw new Error(
          "Voice server does not advertise supported AES-256-GCM RTP-size encryption",
        );
      const ip = text(d.ip, "UDP IP");
      if (!isIP(ip)) throw new Error("Invalid UDP IP");
      const port = integer(d.port, 65535, "UDP port");
      if (!port) throw new Error("Invalid UDP port");
      a.ssrc = integer(d.ssrc, 0xffffffff, "SSRC");
      const udp = createSocket(isIP(ip) === 6 ? "udp6" : "udp4");
      a.udp = udp;
      udp.on("error", (error) => this.fail(a, error));
      udp.on("message", (packet) => {
        if (!this.active(a) || a.selected) return;
        try {
          const discovery = parseDiscoveryResponse(packet, a.ssrc!);
          if (!isIP(discovery.address)) throw new Error("Invalid discovered IP");
          a.selected = true;
          this.sendJson(a, VoiceOpcodes.SelectProtocol, {
            protocol: "udp",
            data: { ...discovery, mode: DISCORD_ENCRYPTION_MODE },
          });
        } catch (error) {
          this.fail(a, errorOf(error));
        }
      });
      udp.connect(port, ip, () => {
        if (!this.active(a)) return;
        udp.send(discoveryRequest(a.ssrc!), (error) => {
          if (error) this.fail(a, error);
        });
      });
    } else if (op === VoiceOpcodes.SessionDescription) {
      if (!a.selected || a.rtp || a.ssrc === undefined)
        throw new Error("Unexpected Session Description");
      const d = object(data);
      if (d.mode !== DISCORD_ENCRYPTION_MODE)
        throw new Error("Voice server selected an unsupported encryption mode");
      if (!Array.isArray(d.secret_key) || d.secret_key.length !== 32)
        throw new Error("Invalid transport key");
      const key = Buffer.from(d.secret_key.map((byte: unknown) => integer(byte, 255, "key byte")));
      a.rtp = new RtpSender(a.ssrc, key);
      key.fill(0);
      a.dave!.configure(
        d.dave_protocol_version === undefined
          ? 0
          : integer(d.dave_protocol_version, 0xffff, "DAVE version"),
      );
      // Keep the handshake deadline until both transport and DAVE are ready.
      void a
        .dave!.waitUntilReady(a.controller.signal, this.options.timeoutMs ?? 15000)
        .then(() => {
          if (!this.active(a)) return;
          a.cleanup[0]!();
          this.stateTo("ready");
          if (!this.active(a)) return;
          a.resolve();
          this.emit("ready");
        })
        .catch((error: unknown) => this.fail(a, errorOf(error)));
    } else {
      // Includes client connect/disconnect (11/13), speaking, and all DAVE transitions.
      a.dave!.handleJson(op, data);
    }
  }
  private readonly acks = new WeakMap<Attempt, (data: unknown) => void>();

  async sendOpus(packet: Buffer, samples = 960, signal?: AbortSignal): Promise<void> {
    const a = this.attempt;
    if (!a?.rtp || !a.udp || this.state !== "ready")
      throw new Error("Voice connection is not ready");
    if (a.sending) throw new Error("Concurrent Opus sends are not supported");
    if (a.ending) throw new Error("Voice transmission is ending");
    a.sending = true;
    const cancellation = signal
      ? AbortSignal.any([signal, a.controller.signal])
      : a.controller.signal;
    try {
      // Await only when necessary: no promises/listeners allocated on the ready hot path.
      if (!a.dave!.ready)
        await a.dave!.waitUntilReady(cancellation, this.options.timeoutMs ?? 15000);
      cancellation.throwIfAborted();
      if (!this.active(a)) throw new Error("Voice disconnected before send");
      const encrypted = a.rtp.packet(a.dave!.encrypt(packet), samples);
      if (!a.speaking) {
        this.sendJson(a, VoiceOpcodes.Speaking, {
          speaking: VoiceSpeakingFlags.Microphone,
          delay: 0,
          ssrc: a.ssrc!,
        });
        a.speaking = true;
      }
      await new Promise<void>((resolve, reject) =>
        a.udp!.send(encrypted, (error) => (error ? reject(error) : resolve())),
      );
      if (!this.active(a)) throw new Error("Voice disconnected during send");
    } catch (error) {
      const failure = errorOf(error);
      if (!cancellation.aborted) this.fail(a, failure);
      throw failure;
    } finally {
      a.sending = false;
    }
  }

  /** Flush Discord's decoder with five paced silence frames before clearing speaking. */
  endTransmission(): Promise<void> {
    const a = this.attempt;
    if (!a || !a.speaking) return Promise.resolve();
    if (a.ending) return a.ending;
    if (a.sending) return Promise.reject(new Error("Cannot end transmission during a send"));
    let task!: Promise<void>;
    task = (async () => {
      let deadline = performance.now();
      try {
        for (let i = 0; i < 5; i++) {
          deadline = Math.max(deadline + 20, performance.now());
          await new Promise<void>((resolve, reject) => {
            const abort = (): void => {
              clearTimeout(timer);
              reject(a.controller.signal.reason);
            };
            const timer = setTimeout(
              () => {
                a.controller.signal.removeEventListener("abort", abort);
                resolve();
              },
              Math.max(0, deadline - performance.now()),
            );
            a.controller.signal.addEventListener("abort", abort, { once: true });
            if (a.controller.signal.aborted) abort();
          });
          // endTransmission owns sending until the tail has completed.
          a.ending = undefined;
          const send = this.sendOpus(OPUS_SILENCE);
          a.ending = task;
          await send;
        }
        this.sendJson(a, VoiceOpcodes.Speaking, { speaking: 0, delay: 0, ssrc: a.ssrc! });
        a.speaking = false;
      } finally {
        a.ending = undefined;
      }
    })();
    a.ending = task;
    return task;
  }

  private fail(a: Attempt, error: Error): void {
    if (!this.active(a)) return;
    this.stop(a, error);
    this.emit("error", error);
  }
  private stop(a: Attempt, reason?: Error): void {
    this.attempt = undefined;
    a.controller.abort(reason ?? new Error("Voice disconnected"));
    const errors: Error[] = [];
    for (const cleanup of a.cleanup.reverse()) {
      try {
        cleanup();
      } catch (error) {
        errors.push(errorOf(error));
      }
    }
    try {
      a.udp?.close();
    } catch (error) {
      errors.push(errorOf(error));
    }
    try {
      a.dave?.destroy();
    } catch (error) {
      errors.push(errorOf(error));
    }
    a.rtp?.destroy();
    a.reject(reason ?? new Error("Voice disconnected"));
    if (this.state !== "destroyed") this.stateTo("disconnected");
    this.emit("disconnect", reason);
    for (const error of errors) this.emit("error", error);
  }
  disconnect(): void {
    const a = this.attempt;
    if (a) this.stop(a);
  }
  destroy(): void {
    if (this.state === "destroyed") return;
    this.stateTo("destroyed");
    this.disconnect();
    this.removeAllListeners();
  }
}
