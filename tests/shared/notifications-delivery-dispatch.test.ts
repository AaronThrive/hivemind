import { describe, it, expect, vi, afterEach } from "vitest";
import { emit } from "../../src/notifications/delivery/index.js";
import type { Notification } from "../../src/notifications/types.js";

/**
 * Per-agent dispatch in delivery/index.ts.
 *
 * Production usually bypasses these adapters: Codex, Cursor and Hermes all own
 * the single JSON object their harness reads, so their hooks pass a `deliver`
 * override and merge the rendered text themselves. The adapters here are the
 * standalone-process path — the one used when a drain runs as its own hook
 * command. They still have to emit the right SHAPE per agent, because each
 * harness parses a different one and silently drops anything else.
 */

const BILLING: Notification = {
  id: "balance-exhausted",
  severity: "warn",
  transient: true,
  title: "Hivemind credits exhausted — top up to keep capturing",
  body: "Sessions are not being saved. Top up at https://deeplake.ai/org-1/workspace/default/billing to restore capture and recall.",
  dedupKey: { reason: "balance-zero" },
  userVisibleOnly: true,
};

const MODEL_SAFE: Notification = {
  id: "welcome",
  title: "Welcome back",
  body: "Connected to org acme.",
  dedupKey: { session: "s" },
};

function captureStdout(): { writes: string[] } {
  const writes: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
    writes.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  });
  return { writes };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("emit — per-agent shape", () => {
  it("claude-code: systemMessage carries everything, additionalContext only model-safe", () => {
    const { writes } = captureStdout();
    emit("claude-code", [BILLING, MODEL_SAFE]);
    const p = JSON.parse(writes.join(""));
    expect(p.systemMessage).toContain("credits exhausted");
    expect(p.systemMessage).toContain("Welcome back");
    expect(p.hookSpecificOutput.additionalContext).toContain("Welcome back");
    expect(p.hookSpecificOutput.additionalContext).not.toContain("credits exhausted");
  });

  it("codex: same dual-channel shape, in ONE JSON object", () => {
    const { writes } = captureStdout();
    emit("codex", [BILLING]);
    expect(writes).toHaveLength(1);
    const p = JSON.parse(writes[0]);
    expect(p.systemMessage).toContain("credits exhausted");
    expect(p.hookSpecificOutput.hookEventName).toBe("SessionStart");
  });

  it("cursor: top-level additional_context — the only field cursor honours", () => {
    const { writes } = captureStdout();
    emit("cursor", [BILLING]);
    const p = JSON.parse(writes.join(""));
    // Billing is relayed as status, not as the user-facing imperative.
    expect(p.additional_context).toContain("credits are exhausted");
    expect(p.additional_context).not.toContain("Top up at");
    expect(p.systemMessage).toBeUndefined();
  });

  it("hermes: {context} — the only shape _parse_response honours", () => {
    const { writes } = captureStdout();
    emit("hermes", [BILLING]);
    const p = JSON.parse(writes.join(""));
    expect(p.context).toContain("credits are exhausted");
    expect(p.additional_context).toBeUndefined();
  });

  it("pi: {notifications:[{text,severity}]} — its own user-visible notify channel", () => {
    const { writes } = captureStdout();
    emit("pi", [BILLING]);
    const p = JSON.parse(writes.join(""));
    // Pi is the only non-Claude-Code harness with a real user-visible channel
    // (ctx.ui.notify), so the notice goes to the USER verbatim — it does not
    // have to be laundered into a status line the way Cursor/Hermes do.
    expect(p.notifications[0].text).toContain("Hivemind credits exhausted");
    expect(p.notifications[0].text).toContain("Top up at");
    expect(p.notifications[0].severity).toBe("warning");
  });

  it("writes nothing at all when there is nothing deliverable", () => {
    for (const agent of ["claude-code", "codex", "cursor", "hermes", "pi"] as const) {
      const { writes } = captureStdout();
      emit(agent, []);
      expect(writes).toEqual([]);
      vi.restoreAllMocks();
    }
    // A model-only agent given ONLY non-status-safe user-visible content has
    // nothing it may relay, so it must stay silent rather than emit an empty
    // context field.
    for (const agent of ["cursor", "hermes"] as const) {
      const { writes } = captureStdout();
      emit(agent, [{ ...BILLING, id: "signup-brief", body: "mined prose" }]);
      expect(writes).toEqual([]);
      vi.restoreAllMocks();
    }
  });
});
