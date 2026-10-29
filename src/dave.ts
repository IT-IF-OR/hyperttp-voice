import { VoiceOpcodes, type VoiceDaveTransitionReadyData } from "discord-api-types/voice/v8";
import { DAVESession, DAVE_PROTOCOL_VERSION } from "@snazzah/davey";

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid DAVE protocol object");
  return value as Record<string, unknown>;
}
function integer(value: unknown, max: number, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max)
    throw new Error(`Invalid DAVE ${name}`);
  return value;
}
function snowflake(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[1-9][0-9]*$/.test(value) ||
    BigInt(value) > 0xffffffffffffffffn
  )
    throw new Error("Invalid DAVE snowflake");
  return value;
}

/** DAVE signaling payloads exclude the voice WebSocket sequence/opcode headers. */
export class DaveAdapter {
  readonly maxProtocolVersion = DAVE_PROTOCOL_VERSION;
  private currentVersion = 0;
  private configured = false;
  private destroyed = false;
  private failed = false;
  private session: DAVESession | undefined;
  private epochVersion = 0;
  private readonly members = new Set<string>();
  private readonly transitions = new Map<number, number>();
  private awaitingExecute: number | undefined;
  private readonly requireDave: boolean;
  private readonly readinessListeners = new Set<() => void>();

  get ready(): boolean {
    return (
      !this.destroyed &&
      !this.failed &&
      this.configured &&
      (this.currentVersion === 0
        ? !this.requireDave
        : this.awaitingExecute === undefined && this.session?.ready === true)
    );
  }

  waitUntilReady(signal?: AbortSignal, timeoutMs = 15000): Promise<void> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
      return Promise.reject(new RangeError("Invalid DAVE readiness timeout"));
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: unknown): void => {
        if (timer !== undefined) clearTimeout(timer);
        this.readinessListeners.delete(check);
        signal?.removeEventListener("abort", abort);
        if (error !== undefined) reject(error);
        else resolve();
      };
      const abort = (): void => finish(signal?.reason ?? new Error("DAVE readiness aborted"));
      const check = (): void => {
        if (signal?.aborted) return abort();
        if (this.destroyed) return finish(new Error("DAVE adapter is destroyed"));
        if (this.failed) return finish(new Error("DAVE adapter has failed"));
        if (this.ready) finish();
      };
      this.readinessListeners.add(check);
      signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => finish(new Error("DAVE readiness timed out")), timeoutMs);
      check();
    });
  }

  private notifyReadiness(): void {
    for (const listener of this.readinessListeners) listener();
  }

  constructor(
    private readonly userId: string,
    private readonly channelId: string,
    private readonly sendJson: (
      op: VoiceOpcodes.DaveTransitionReady | VoiceOpcodes.DaveMlsInvalidCommitWelcome,
      data: VoiceDaveTransitionReadyData,
    ) => void,
    private readonly sendBinary: (op: number, payload: Buffer) => void,
    options: { requireDave?: boolean } = {},
  ) {
    snowflake(userId);
    snowflake(channelId);
    this.members.add(userId);
    this.requireDave = options.requireDave ?? true;
  }

  get version(): number {
    return this.currentVersion;
  }

  private alive(): void {
    if (this.destroyed) throw new Error("DAVE adapter is destroyed");
    if (this.failed) throw new Error("DAVE adapter has failed");
  }
  private protocol(value: unknown): number {
    const version = integer(value, this.maxProtocolVersion, "protocol version");
    if (version === 0 && this.requireDave)
      throw new Error("DAVE is required; refusing transport-only encryption");
    return version;
  }
  private guard<T>(action: () => T): T {
    this.alive();
    try {
      return action();
    } catch (error) {
      this.failed = true;
      throw error;
    } finally {
      this.notifyReadiness();
    }
  }
  private initialize(version: number): void {
    this.transitions.clear();
    this.awaitingExecute = undefined;
    this.epochVersion = version;
    if (version === 0) {
      this.session?.reset();
      return;
    }
    if (this.session) this.session.reinit(version, this.userId, this.channelId);
    else this.session = new DAVESession(version, this.userId, this.channelId);
    this.sendBinary(VoiceOpcodes.DaveMlsKeyPackage, this.session.getSerializedKeyPackage());
  }
  configure(version: number): void {
    this.guard(() => {
      if (this.configured) throw new Error("DAVE is already configured");
      const selected = this.protocol(version);
      this.initialize(selected);
      this.currentVersion = selected;
      this.configured = true;
    });
  }
  private native(): DAVESession {
    if (!this.configured || !this.session || this.epochVersion === 0)
      throw new Error("DAVE MLS session is not configured");
    return this.session;
  }
  private execute(id: number): void {
    const version = this.transitions.get(id);
    if (version === undefined) throw new Error(`Unknown DAVE transition ${id}`);
    if (this.awaitingExecute !== undefined && this.awaitingExecute !== id)
      throw new Error("DAVE transition does not match pending MLS keys");
    this.currentVersion = version;
    this.transitions.delete(id);
    if (this.awaitingExecute === id) this.awaitingExecute = undefined;
  }

  handleJson(op: number, data: unknown): boolean {
    if (
      op !== VoiceOpcodes.ClientsConnect &&
      op !== VoiceOpcodes.ClientDisconnect &&
      op !== VoiceOpcodes.DavePrepareTransition &&
      op !== VoiceOpcodes.DaveExecuteTransition &&
      op !== VoiceOpcodes.DavePrepareEpoch
    )
      return false;
    return this.guard(() => {
      const d = object(data);
      if (op === VoiceOpcodes.ClientsConnect) {
        if (!Array.isArray(d.user_ids)) throw new Error("Invalid DAVE member list");
        const ids = d.user_ids.map((id: unknown) => snowflake(id));
        for (const id of ids) this.members.add(id);
      } else if (op === VoiceOpcodes.ClientDisconnect) {
        this.members.delete(snowflake(d.user_id));
      } else {
        if (!this.configured) throw new Error("DAVE is not configured");
        if (op === VoiceOpcodes.DavePrepareEpoch) {
          const epoch = integer(d.epoch, Number.MAX_SAFE_INTEGER, "epoch");
          const version = this.protocol(d.protocol_version);
          if (epoch === 0 || version === 0) throw new Error("Invalid DAVE MLS epoch");
          if (epoch === 1) this.initialize(version);
          else this.epochVersion = version;
        } else {
          const id = integer(d.transition_id, 0xffff, "transition ID");
          if (op === VoiceOpcodes.DaveExecuteTransition) this.execute(id);
          else {
            const version = this.protocol(d.protocol_version);
            if (version > 0 && version !== this.epochVersion)
              throw new Error("DAVE transition has no prepared epoch");
            if (this.transitions.has(id)) throw new Error("Duplicate DAVE transition");
            this.transitions.set(id, version);
            if (id === 0) this.execute(id);
            else this.sendJson(VoiceOpcodes.DaveTransitionReady, { transition_id: id });
          }
        }
      }
      return true;
    });
  }

  handleBinary(op: number, payload: Buffer): boolean {
    if (
      op !== VoiceOpcodes.DaveMlsExternalSender &&
      op !== VoiceOpcodes.DaveMlsProposals &&
      op !== VoiceOpcodes.DaveMlsAnnounceCommitTransition &&
      op !== VoiceOpcodes.DaveMlsWelcome
    )
      return false;
    return this.guard(() => {
      const session = this.native();
      if (op === VoiceOpcodes.DaveMlsExternalSender) {
        session.setExternalSender(payload);
      } else if (op === VoiceOpcodes.DaveMlsProposals) {
        const operation = payload[0];
        if (operation !== 0 && operation !== 1) throw new Error("Invalid DAVE proposal operation");
        const { commit, welcome } = session.processProposals(operation, payload.subarray(1), [
          ...this.members,
        ]);
        if (commit)
          this.sendBinary(
            VoiceOpcodes.DaveMlsCommitWelcome,
            welcome ? Buffer.concat([commit, welcome]) : commit,
          );
      } else {
        if (payload.length < 2) throw new Error("Truncated DAVE transition ID");
        const id = payload.readUInt16BE(0);
        // Only native commit/welcome failures trigger protocol recovery, never transport errors.
        try {
          if (op === VoiceOpcodes.DaveMlsAnnounceCommitTransition)
            session.processCommit(payload.subarray(2));
          else session.processWelcome(payload.subarray(2));
        } catch {
          this.transitions.clear();
          this.awaitingExecute = undefined;
          // Reset before notifying the server so failed callbacks cannot leave old keys usable.
          session.reset();
          this.sendJson(VoiceOpcodes.DaveMlsInvalidCommitWelcome, { transition_id: id });
          this.initialize(this.epochVersion);
          return true;
        }
        this.transitions.set(id, this.epochVersion);
        if (id === 0) this.execute(id);
        else {
          // Davey activates sender keys during processCommit/processWelcome. Do not send
          // with those keys before the gateway executes the corresponding transition.
          this.awaitingExecute = id;
          this.sendJson(VoiceOpcodes.DaveTransitionReady, { transition_id: id });
        }
      }
      return true;
    });
  }

  encrypt(packet: Buffer): Buffer {
    this.alive();
    if (!this.configured) throw new Error("DAVE is not configured");
    if (this.currentVersion === 0) {
      if (this.requireDave) throw new Error("DAVE is required");
      return packet;
    }
    if (this.awaitingExecute !== undefined || !this.session?.ready)
      throw new Error("DAVE encryption is not ready");
    return this.guard(() => this.session!.encryptOpus(packet));
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.currentVersion = 0;
    this.configured = false;
    this.transitions.clear();
    this.members.clear();
    const session = this.session;
    this.session = undefined;
    this.notifyReadiness();
    session?.reset();
  }
}
