import { DAVESession, DAVE_PROTOCOL_VERSION } from "@snazzah/davey";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaveAdapter } from "../src/dave.js";

// Recorded gateway fixtures from Snazzah/davey (MIT), davey-node/test/session.test.ts.
const external = Buffer.from(
  "404104ca1a2b102501d0672bd45ed74ffb83e078b2ba5b12c3f69fad56f083b6a35fc989c6736b5852b5aecdfcdf206e156d3d1dba8e3e5b2f89fc0c16f11614e84e4a00010100",
  "hex",
);
const proposals = Buffer.from(
  "41f000010001080cde77eadc823033000000000000000002000000000002000100010002404104a61acd34ff0548e6f767cc4df9619b51ba5814d52ee558284fc554405768e9e741ba32276414941b7c0190dcb5dfc3349a168f1247ecbdf6fc69f3eecab3765d404104f44da24e5aa9f73796fa38be115556e6b7d4f6ba55d2ecc3f1b9d198af6237e3fc8fc635996b6c76e77b4acace33f5cfd745ad0d540dd6f03f0da85c82e14714404104e7793985ed074af49568b53cf2e3974688279f02ee8d7c7df099ce3c7a1a28e747f59a7c7c23e9ef4f7815fb3469f39ea124f8b76712c41b763a55b867e6b48b00010802333999400200000200010200020000020001010000000000000000ffffffffffffffff0040483046022100d874dc777d4ede7e6d3374f737bc1394ac0ffd0635abdc9d02b3e359e059466a022100e62e97aefd5c6b32ff0ac5c5159dbe94f6f5a01bd0dd14a9dcc4d1e6248972ac004047304502205168abdf8d83a48daf8d5960afb305022de707c7496087feb43004c9fd2be5e80221008312a6f6df1ff593671a39f9966f6d1caef43e0c6d53c74300ba089ceeecfbf440473045022100cdbe804ba06a9be17615fe3c7f9055f31a6d0ea9402dd9fda6d109e9a3cb632b022067409e59f6b7f0a3eddd330a092a6c13d99d12abaebe0d6d40a0dae435c2a7a2",
  "hex",
);
const revoked = Buffer.from(
  "212062386ffb20b28f556b2465c0a2520ba2b074fca00e94b2fdebc0496d544cd6c0",
  "hex",
);
const user = "158049329150427136";
const other = "158533742254751744";
const channel = "927310423890473011";
const audio = Buffer.from([0x78, 0x01, 0x02, 0x03]);
const adapters: DaveAdapter[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const adapter of adapters.splice(0)) adapter.destroy();
});
function setup(requireDave = true) {
  const json = vi.fn<(op: number, data: unknown) => void>();
  const binary = vi.fn<(op: number, payload: Buffer) => void>();
  const adapter = new DaveAdapter(user, channel, json, binary, { requireDave });
  adapters.push(adapter);
  return { adapter, json, binary };
}
function pending(requireDave = true) {
  const context = setup(requireDave);
  context.adapter.configure(1);
  context.adapter.handleJson(11, { user_ids: [other] });
  context.adapter.handleBinary(25, external);
  return context;
}
function transition(id: number, payload: Buffer) {
  const prefix = Buffer.alloc(2);
  prefix.writeUInt16BE(id);
  return Buffer.concat([prefix, payload]);
}
function commitFor(adapter: DaveAdapter): Buffer {
  // Observe the real result without replacing the native implementation.
  const spy = vi.spyOn(DAVESession.prototype, "processProposals");
  adapter.handleBinary(27, Buffer.concat([Buffer.from([0]), proposals]));
  const result = spy.mock.results.at(-1);
  if (result?.type !== "return" || !result.value.commit) throw new Error("Expected native commit");
  return result.value.commit;
}
function active(requireDave = true) {
  const context = pending(requireDave);
  const commit = commitFor(context.adapter);
  context.adapter.handleBinary(29, transition(7, commit));
  context.adapter.handleJson(22, { transition_id: 7 });
  return context;
}

describe("DaveAdapter with the installed native library", () => {
  it("starts unready and resolves existing and new waits in explicit transport-only mode", async () => {
    const { adapter } = setup(false);
    expect(adapter.ready).toBe(false);
    const waiting = adapter.waitUntilReady(undefined, 500);
    adapter.configure(0);
    expect(adapter.ready).toBe(true);
    await expect(waiting).resolves.toBeUndefined();
    await expect(adapter.waitUntilReady(undefined, 500)).resolves.toBeUndefined();
    adapter.destroy();
    expect(adapter.ready).toBe(false);
  });

  it("notifies all readiness waits only after native keys and their execute transition are ready", async () => {
    const { adapter } = pending();
    expect(adapter.ready).toBe(false);
    const resolved = vi.fn();
    const first = adapter.waitUntilReady(undefined, 500).then(resolved);
    const second = adapter.waitUntilReady(undefined, 500);
    const commit = commitFor(adapter);
    expect(adapter.ready).toBe(false);
    adapter.handleBinary(29, transition(7, commit));
    expect(adapter.ready).toBe(false);
    await Promise.resolve();
    expect(resolved).not.toHaveBeenCalled();
    adapter.handleJson(22, { transition_id: 7 });
    expect(adapter.ready).toBe(true);
    await Promise.all([first, second]);
    expect(resolved).toHaveBeenCalledOnce();
    await expect(adapter.waitUntilReady(undefined, 500)).resolves.toBeUndefined();
  });

  it("notifies readiness waits for an immediately executed native initialization commit", async () => {
    const { adapter } = pending();
    const waiting = adapter.waitUntilReady(undefined, 500);
    adapter.handleBinary(29, transition(0, commitFor(adapter)));
    expect(adapter.ready).toBe(true);
    await expect(waiting).resolves.toBeUndefined();
  });

  it("becomes unready after native recovery and notifies waits when replacement keys execute", async () => {
    const { adapter } = active();
    expect(adapter.ready).toBe(true);
    adapter.handleBinary(29, transition(42, Buffer.from([1, 2, 3])));
    expect(adapter.ready).toBe(false);
    const waiting = adapter.waitUntilReady(undefined, 500);
    adapter.handleBinary(25, external);
    adapter.handleBinary(29, transition(0, commitFor(adapter)));
    expect(adapter.ready).toBe(true);
    await expect(waiting).resolves.toBeUndefined();
  });

  it("times out without making the adapter or other readiness waits fail", async () => {
    const { adapter } = pending();
    const waiting = adapter.waitUntilReady(undefined, 500);
    await expect(adapter.waitUntilReady(undefined, 10)).rejects.toThrow(/timed out/);
    expect(adapter.ready).toBe(false);
    adapter.handleBinary(29, transition(0, commitFor(adapter)));
    await expect(waiting).resolves.toBeUndefined();
    expect(adapter.ready).toBe(true);
  });

  it.each([false, true])("rejects with the abort reason (already aborted=%s)", async (aborted) => {
    const { adapter } = pending();
    const controller = new AbortController();
    const reason = new Error("readiness cancelled");
    const unaffected = adapter.waitUntilReady(undefined, 500);
    if (aborted) controller.abort(reason);
    const rejection = expect(adapter.waitUntilReady(controller.signal, 500)).rejects.toBe(reason);
    if (!aborted) controller.abort(reason);
    await rejection;
    expect(adapter.ready).toBe(false);
    adapter.handleBinary(29, transition(0, commitFor(adapter)));
    await expect(unaffected).resolves.toBeUndefined();
    expect(adapter.ready).toBe(true);
  });

  it("rejects pending and subsequent readiness waits when destroyed", async () => {
    const { adapter } = pending();
    const first = expect(adapter.waitUntilReady(undefined, 500)).rejects.toThrow(/destroyed/);
    const second = expect(adapter.waitUntilReady(undefined, 500)).rejects.toThrow(/destroyed/);
    adapter.destroy();
    expect(adapter.ready).toBe(false);
    await Promise.all([first, second]);
    await expect(adapter.waitUntilReady(undefined, 500)).rejects.toThrow(/destroyed/);
  });

  it("notifies readiness waits when guarded native signaling fails", async () => {
    const { adapter } = pending();
    const rejection = expect(adapter.waitUntilReady(undefined, 500)).rejects.toThrow(/failed/);
    expect(() => adapter.handleBinary(25, Buffer.alloc(0))).toThrow();
    expect(adapter.ready).toBe(false);
    await rejection;
    await expect(adapter.waitUntilReady(undefined, 500)).rejects.toThrow(/failed/);
  });
  it("advertises the native version, emits fresh native key packages and blocks unready audio", () => {
    const { adapter, binary } = setup();
    expect(adapter.maxProtocolVersion).toBe(DAVE_PROTOCOL_VERSION);
    expect(() => adapter.encrypt(audio)).toThrow(/not configured/);
    adapter.configure(1);
    expect(adapter.version).toBe(1);
    expect(binary).toHaveBeenCalledWith(26, expect.any(Buffer));
    const first = binary.mock.calls[0]![1];
    expect(first.length).toBeGreaterThan(300);
    expect(first.subarray(0, 4)).toEqual(Buffer.from([0, 1, 0, 2]));
    expect(() => adapter.encrypt(audio)).toThrow(/not ready/);
    adapter.handleJson(24, { epoch: 1, protocol_version: 1 });
    expect(binary.mock.calls[1]![1]).not.toEqual(first);
  });

  it("processes native proposals, forwards commit+welcome, and waits for execute", () => {
    const { adapter, json, binary } = pending();
    const spy = vi.spyOn(DAVESession.prototype, "processProposals");
    const commit = commitFor(adapter);
    const result = spy.mock.results.at(-1);
    if (result?.type !== "return" || !result.value.welcome)
      throw new Error("Expected native welcome");
    expect(binary).toHaveBeenLastCalledWith(28, Buffer.concat([commit, result.value.welcome]));
    expect(spy).toHaveBeenLastCalledWith(0, proposals, [user, other]);
    adapter.handleBinary(29, transition(0x1234, commit));
    expect(json).toHaveBeenLastCalledWith(23, { transition_id: 0x1234 });
    expect(() => adapter.encrypt(audio)).toThrow(/not ready/);
    adapter.handleJson(22, { transition_id: 0x1234 });
    const encrypted = adapter.encrypt(audio);
    expect(encrypted).not.toEqual(audio);
    expect(encrypted.subarray(-2)).toEqual(Buffer.from([0xfa, 0xfa]));
    expect(adapter.encrypt(audio)).not.toEqual(encrypted);
    expect(adapter.encrypt(Buffer.from([0xf8, 0xff, 0xfe]))).toEqual(
      Buffer.from([0xf8, 0xff, 0xfe]),
    );
  });

  it("handles native revocation without sending an empty commit", () => {
    const { adapter, binary } = pending();
    commitFor(adapter);
    binary.mockClear();
    expect(adapter.handleBinary(27, Buffer.concat([Buffer.from([1]), revoked]))).toBe(true);
    expect(binary).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "rejects unrecognized or disconnected proposal members (disconnect=%s)",
    (disconnect) => {
      const { adapter, binary } = pending();
      if (disconnect) adapter.handleJson(13, { user_id: other });
      else {
        adapter.handleJson(13, { user_id: other });
        adapter.handleJson(11, { user_ids: ["123"] });
      }
      expect(() => commitFor(adapter)).toThrow();
      expect(binary.mock.calls.filter(([op]) => op === 28)).toHaveLength(0);
      expect(() => adapter.encrypt(audio)).toThrow(/failed/);
    },
  );

  it.each([29, 30])(
    "recovers from invalid native opcode %s, without acknowledging invalid keys",
    (op) => {
      const { adapter, json, binary } = active();
      const oldKey = binary.mock.calls[0]![1];
      json.mockClear();
      adapter.handleBinary(op, transition(42, Buffer.from([1, 2, 3])));
      expect(json.mock.calls).toEqual([[31, { transition_id: 42 }]]);
      expect(binary).toHaveBeenLastCalledWith(26, expect.any(Buffer));
      expect(binary.mock.calls.at(-1)![1]).not.toEqual(oldKey);
      expect(() => adapter.encrypt(audio)).toThrow(/not ready/);
      adapter.handleBinary(25, external);
      adapter.handleBinary(29, transition(0, commitFor(adapter)));
      expect(adapter.encrypt(audio).subarray(-2)).toEqual(Buffer.from([0xfa, 0xfa]));
    },
  );

  it("executes initialization transitions immediately without a ready response", () => {
    const { adapter, json } = pending();
    adapter.handleJson(21, { transition_id: 0, protocol_version: 1 });
    expect(json).not.toHaveBeenCalled();
    adapter.handleBinary(29, transition(0, commitFor(adapter)));
    expect(json).not.toHaveBeenCalled();
    expect(adapter.encrypt(audio)).not.toEqual(audio);
  });

  it("defaults to requiring DAVE and refuses downgrades", () => {
    const adapter = new DaveAdapter(
      user,
      channel,
      () => {},
      () => {},
    );
    adapters.push(adapter);
    expect(() => adapter.configure(0)).toThrow(/required/);
    expect(() => adapter.encrypt(audio)).toThrow(/failed/);
    const context = active();
    expect(() => context.adapter.handleJson(21, { transition_id: 9, protocol_version: 0 })).toThrow(
      /required/,
    );
    expect(() => context.adapter.encrypt(audio)).toThrow(/failed/);
    expect(context.json).not.toHaveBeenCalledWith(23, { transition_id: 9 });
  });

  it("allows explicit transport-only mode and upgrade/downgrade only at execution", () => {
    const { adapter, json } = setup(false);
    expect(() => adapter.encrypt(audio)).toThrow(/not configured/);
    adapter.configure(0);
    expect(adapter.encrypt(audio)).toBe(audio);
    adapter.handleJson(24, { epoch: 1, protocol_version: 1 });
    expect(adapter.version).toBe(0);
    adapter.handleBinary(25, external);
    adapter.handleJson(11, { user_ids: [other] });
    adapter.handleBinary(29, transition(5, commitFor(adapter)));
    adapter.handleJson(22, { transition_id: 5 });
    expect(adapter.version).toBe(1);
    adapter.handleJson(21, { transition_id: 6, protocol_version: 0 });
    expect(json).toHaveBeenLastCalledWith(23, { transition_id: 6 });
    expect(adapter.version).toBe(1);
    expect(adapter.encrypt(audio)).not.toEqual(audio);
    adapter.handleJson(22, { transition_id: 6 });
    expect(adapter.version).toBe(0);
    expect(adapter.encrypt(audio)).toBe(audio);
  });

  it("does not regenerate key packages for retained epochs", () => {
    const { adapter, binary } = active();
    binary.mockClear();
    adapter.handleJson(24, { epoch: 2, protocol_version: 1 });
    expect(binary).not.toHaveBeenCalled();
    expect(adapter.encrypt(audio)).not.toEqual(audio);
  });

  it.each([25, 27, 29, 30])("fails closed for truncated binary opcode %s", (op) => {
    const { adapter } = pending();
    expect(() => adapter.handleBinary(op, Buffer.alloc(0))).toThrow();
    expect(() => adapter.encrypt(audio)).toThrow(/failed/);
  });

  it.each([
    [21, { transition_id: -1, protocol_version: 1 }],
    [21, { transition_id: 1, protocol_version: 999 }],
    [22, { transition_id: 999 }],
    [24, { epoch: 0, protocol_version: 1 }],
    [24, { epoch: 1, protocol_version: 0 }],
    [11, { user_ids: ["not-a-snowflake"] }],
    [13, null],
  ] as const)("rejects malformed/unexpected JSON opcode %s", (op, data) => {
    const { adapter } = setup(false);
    adapter.configure(0);
    expect(() => adapter.handleJson(op, data)).toThrow();
    expect(() => adapter.encrypt(audio)).toThrow(/failed/);
  });

  it("propagates callback errors instead of misreporting them as invalid MLS", () => {
    const { adapter, json } = pending();
    const commit = commitFor(adapter);
    json.mockImplementation(() => {
      throw new Error("socket closed");
    });
    expect(() => adapter.handleBinary(29, transition(4, commit))).toThrow("socket closed");
    expect(json.mock.calls.map(([op]) => op)).toEqual([23]);
    expect(() => adapter.encrypt(audio)).toThrow(/failed/);
  });

  it("fails closed when key-package transmission fails", () => {
    const { adapter, binary } = setup(false);
    binary.mockImplementation(() => {
      throw new Error("send failed");
    });
    expect(() => adapter.configure(1)).toThrow("send failed");
    expect(() => adapter.encrypt(audio)).toThrow(/failed/);
  });

  it("propagates native encryption failures without falling back to plaintext", () => {
    const { adapter } = active(false);
    vi.spyOn(DAVESession.prototype, "encryptOpus").mockImplementation(() => {
      throw new Error("native failure");
    });
    expect(() => adapter.encrypt(audio)).toThrow("native failure");
    expect(() => adapter.encrypt(audio)).toThrow(/failed/);
  });

  it("ignores unrelated messages, prevents reconfiguration, and destroys idempotently", () => {
    const { adapter } = setup(false);
    expect(adapter.handleJson(5, null)).toBe(false);
    expect(adapter.handleBinary(99, Buffer.alloc(0))).toBe(false);
    adapter.configure(0);
    expect(() => adapter.configure(0)).toThrow(/already configured/);
    adapter.destroy();
    adapter.destroy();
    expect(adapter.version).toBe(0);
    expect(() => adapter.encrypt(audio)).toThrow(/destroyed/);
    expect(() => adapter.handleJson(11, { user_ids: [] })).toThrow(/destroyed/);
  });
});
