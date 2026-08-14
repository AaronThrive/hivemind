#!/usr/bin/env node

/**
 * Pi notifications worker.
 *
 * Pi is the one non-Claude-Code harness with a real user-visible channel:
 * `ctx.ui.notify(message, "info" | "warning" | "error")` (verified against the
 * installed `@mariozechner/pi-coding-agent` typings — `dist/core/extensions/
 * types.d.ts`). So unlike Cursor and Hermes, a Pi user can be told directly and
 * the notice does NOT have to be laundered through the model.
 *
 * The extension can't drain the queue itself: `harnesses/pi/extension-source/
 * hivemind.ts` is raw TS with no non-builtin imports, loaded by pi's own
 * compiler. It follows the same pattern as autopull — spawn a bundled worker
 * and read its stdout. This is that worker.
 *
 * Output: one JSON object on stdout, `{ "notifications": [{ text, severity }] }`,
 * one entry per notification so the extension can pick the right notify() level
 * per item. Empty array when there is nothing to show. Never throws: pi must
 * not lose a session because a notification failed.
 */

import { loadCredentials } from "../../commands/auth.js";
import { drainSessionStart, registerRule } from "../../notifications/index.js";
import type { Notification } from "../../notifications/index.js";
import { bumpSessionCount } from "../../notifications/state.js";
import { referralInviteRule } from "../../notifications/rules/referral-invite.js";
import { renderNotifications } from "../../notifications/format.js";
import { log as _log } from "../../utils/debug.js";

const log = (msg: string) => _log("pi-notifications", msg);

registerRule(referralInviteRule);

/** pi's notify() levels. Our "info" maps to "info"; warn/error both escalate. */
function piLevel(n: Notification): "info" | "warning" | "error" {
  if (n.severity === "error") return "error";
  if (n.severity === "warn") return "warning";
  return "info";
}

async function main(): Promise<void> {
  const sessionId = (process.argv[2] ?? "").trim() || undefined;
  const source = (process.argv[3] ?? "").trim() || undefined;

  let claimed: Notification[] = [];
  await drainSessionStart({
    agent: "pi",
    creds: loadCredentials(),
    sessionId,
    source,
    sessionCount: bumpSessionCount(sessionId),
    deliver: (ns) => { claimed = ns; },
  });

  // One rendered string per notification: pi shows each as its own toast, so
  // batching them into a single blob would flatten the severity distinction.
  const notifications = claimed.map(n => ({
    text: renderNotifications([n]),
    severity: piLevel(n),
  }));
  log(`emitting ${notifications.length} notification(s)`);
  process.stdout.write(JSON.stringify({ notifications }));
}

main().catch((e) => {
  log(`fatal: ${e?.message ?? String(e)}`);
  // Always emit valid JSON — the extension parses stdout unconditionally.
  process.stdout.write(JSON.stringify({ notifications: [] }));
  process.exit(0);
});
