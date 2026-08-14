/**
 * Delivery for agents whose harness has NO user-visible session-start channel.
 * Today: Cursor and Hermes.
 *
 * Cursor was verified empirically
 * 2026-08-13 against cursor-agent 2026.08.11 with a marker probe wired into
 * `~/.cursor/hooks.json`:
 *
 *   - top-level `additional_context` → reaches the MODEL (the probe token came
 *     back when the model was asked to echo it). Never printed to the user.
 *   - top-level `systemMessage`      → dropped entirely.
 *   - nested `hookSpecificOutput.additionalContext` → dropped entirely.
 *   - stderr                          → never shown.
 *
 * Hermes is the same shape by a different route: `on_session_start`'s return
 * value is discarded by the caller, and `_parse_response` in
 * `agent/shell_hooks.py` only honours `{"context": "..."}` — model context.
 *
 * So on these agents the only route from a notification to the user runs
 * THROUGH the model. That forces a different rendering than Claude Code and Codex, where
 * `userVisibleOnly` notifications are withheld from the model channel to keep
 * LLM-derived prose out of a future session's prompt (the prompt-injection
 * guard from the codex review).
 *
 * The compromise: on an agent with no user channel, a `userVisibleOnly`
 * notification is rendered as a STATEMENT OF FACT, not as copy addressed to
 * the user. "Hivemind status: credits are exhausted; capture and recall are
 * disabled" is state the model may relay; "Top up at <url> to keep capturing"
 * is an imperative aimed at the user and is exactly the shape external
 * reviewers flag. Billing state is worth relaying — silence is how this whole
 * class of bug started — but it is relayed as status, never as instruction.
 */

import type { Notification } from "../types.js";
import { renderNotifications } from "../format.js";

/** Notifications whose body is statically authored by us and safe to render
 *  verbatim into the model channel. Anything else (mined insights, backend
 *  pushes) stays out — its body is not ours. */
const STATUS_SAFE_IDS = new Set(["balance-exhausted", "balance-low"]);

/**
 * Recast a user-facing billing notice as a neutral status line. Deliberately
 * drops the imperative ("Top up at …") and keeps the facts: what is true, what
 * it breaks, and where billing lives.
 */
function asStatusLine(n: Notification): string | null {
  if (!STATUS_SAFE_IDS.has(n.id)) return null;
  const url = /https?:\/\/\S+/.exec(n.body)?.[0]?.replace(/[.,]$/, "");
  const what = n.id === "balance-exhausted"
    ? "the organization's Deeplake credits are exhausted; session capture and memory recall are disabled"
    : "the organization's Deeplake balance is nearly empty; session capture and memory recall will stop working shortly";
  return `Hivemind status: ${what}${url ? ` (billing: ${url})` : ""}.`;
}

/**
 * Build the context string for a model-only channel (Cursor's
 * `additional_context`, Hermes's `{"context": ...}`). Returns "" when there is
 * nothing deliverable, so the caller can skip appending.
 */
export function renderModelChannelContext(notifications: Notification[]): string {
  if (notifications.length === 0) return "";
  const modelSafe = notifications.filter(n => !n.userVisibleOnly);
  const statusLines = notifications
    .filter(n => n.userVisibleOnly)
    .map(asStatusLine)
    .filter((l): l is string => l !== null);
  return [renderNotifications(modelSafe), ...statusLines]
    .filter(Boolean)
    .join("\n\n");
}
