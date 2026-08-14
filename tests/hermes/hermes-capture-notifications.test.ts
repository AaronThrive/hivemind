import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Hermes notification delivery, from the pre_llm_call capture hook.
 *
 * Hermes has NO user-visible session-start channel: `on_session_start`'s
 * return value is discarded upstream (run_agent.py), and `_parse_response` in
 * agent/shell_hooks.py honours `{"context": "..."}` for `pre_llm_call` alone.
 * So a Hermes user whose org ran out of credits got no signal at all until
 * this landed — capture and recall just silently returned nothing.
 *
 * Delivery rides the ALREADY-REGISTERED pre_llm_call hook, so installing it
 * needs no config change and triggers no re-consent prompt.
 */

const stdinMock = vi.fn();
const loadConfigMock = vi.fn();
const drainMock = vi.fn();
let TEMP_DIR = "";

vi.mock("../../src/utils/stdin.js", () => ({ readStdin: (...a: unknown[]) => stdinMock(...a) }));
vi.mock("../../src/config.js", () => ({ loadConfig: (...a: unknown[]) => loadConfigMock(...a) }));
vi.mock("../../src/utils/debug.js", () => ({ log: () => undefined }));
vi.mock("../../src/commands/auth.js", () => ({
  loadCredentials: () => ({ token: "t", orgId: "o", orgName: "acme", workspaceId: "default" }),
}));
vi.mock("../../src/deeplake-api.js", () => ({
  DeeplakeApi: class { async query() { return []; } async commit() {} enqueue() {} },
  describeNetworkFailure: (e: unknown) => e,
}));
vi.mock("../../src/embeddings/client.js", () => ({ embedText: async () => null }));
vi.mock("../../src/utils/session-path.js", () => ({ buildSessionPath: () => "/tmp/x.jsonl" }));
vi.mock("../../src/hooks/session-event-cache.js", () => ({
  appendSessionEvent: () => undefined,
  sessionEventCachePath: (id: string) => join(TEMP_DIR, `${id}.jsonl`),
}));
vi.mock("../../src/notifications/index.js", () => ({
  drainSessionStart: (...a: unknown[]) => drainMock(...a),
}));

const BILLING = {
  id: "balance-exhausted",
  severity: "warn" as const,
  transient: true,
  title: "Hivemind credits exhausted — top up to keep capturing",
  body: "Sessions are not being saved. Top up at https://deeplake.ai/o/workspace/default/billing to restore capture and recall.",
  dedupKey: { reason: "balance-zero" },
  userVisibleOnly: true,
};

async function runHook(): Promise<string[]> {
  const writes: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
    writes.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  });
  vi.resetModules();
  try {
    await import("../../src/hooks/hermes/capture.js");
    for (let i = 0; i < 100 && writes.length === 0; i++) {
      await new Promise(r => setTimeout(r, 5));
    }
  } finally {
    spy.mockRestore();
  }
  return writes;
}

beforeEach(() => {
  TEMP_DIR = mkdtempSync(join(tmpdir(), "hermes-notif-"));
  // NOTE: capture must stay ENABLED. Delivery rides the pre_llm_call capture
  // path, which returns early when HIVEMIND_CAPTURE=false — a user who turns
  // capture off gets no billing notice either, which is the intended tradeoff
  // (nothing is being captured, so there is nothing to warn about losing).
  delete process.env.HIVEMIND_CAPTURE;
  stdinMock.mockReset().mockResolvedValue({
    hook_event_name: "pre_llm_call",
    session_id: "sess-1",
    cwd: "/x",
    extra: { prompt: "hello" },
  });
  loadConfigMock.mockReset().mockReturnValue({
    token: "t", orgId: "o", orgName: "acme", workspaceId: "default",
    userName: "alice", apiUrl: "http://example",
    tableName: "memory", sessionsTableName: "sessions",
  });
  drainMock.mockReset().mockImplementation(async (opts: any) => { opts.deliver([BILLING]); });
});

afterEach(() => {
  if (TEMP_DIR) rmSync(TEMP_DIR, { recursive: true, force: true });
});

describe("hermes capture — notification delivery on pre_llm_call", () => {
  it("emits {context} — the only shape hermes honours — as agent 'hermes'", async () => {
    const writes = await runHook();
    expect(drainMock).toHaveBeenCalledTimes(1);
    expect(drainMock.mock.calls[0][0].agent).toBe("hermes");

    const payload = JSON.parse(writes.join(""));
    // Relayed as status, never as the user-facing imperative: on a model-only
    // channel "Top up at <url>" is the prompt-injection shape reviewers flag.
    expect(payload.context).toContain("credits are exhausted");
    expect(payload.context).toContain("https://deeplake.ai/o/workspace/default/billing");
    expect(payload.context).not.toContain("Top up at");
  });

  it("fires once per session — later turns of the same session stay silent", async () => {
    const first = await runHook();
    expect(first.join("")).toContain("credits are exhausted");

    // Same session id → the sentinel already exists → no second drain.
    drainMock.mockClear();
    const second = await runHook();
    expect(drainMock).not.toHaveBeenCalled();
    expect(second.join("")).not.toContain("credits are exhausted");
    expect(existsSync(join(TEMP_DIR, ".notified-sess-1"))).toBe(true);
  });

  it("stays silent when there is nothing to deliver", async () => {
    drainMock.mockImplementation(async (opts: any) => { opts.deliver([]); });
    const writes = await runHook();
    expect(writes.join("")).toBe("");
  });

  it("never lets a notification failure break capture", async () => {
    drainMock.mockImplementation(async () => { throw new Error("drain exploded"); });
    await expect(runHook()).resolves.toBeDefined();
  });
});
