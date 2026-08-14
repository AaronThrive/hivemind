/**
 * Codex SessionStart-hook delivery.
 *
 * Codex accepts the same dual-channel JSON shape as Claude Code (verified
 * against codex-rs 0.130.0 — see ../AGENT_CHANNELS.md → "Codex"):
 *
 *   - top-level `systemMessage` → rendered to the user as `warning: <text>`
 *     inside the `• SessionStart hook (completed)` history cell.
 *   - `hookSpecificOutput.additionalContext` → pushed to the model AND
 *     rendered to the user as `hook context: <text>`. Unlike Claude Code,
 *     Codex has no model-only channel.
 *
 * The `userVisibleOnly` split is kept identical to Claude Code's: bodies
 * carrying LLM-derived prose stay out of `additionalContext` so they are
 * never re-injected into a later session's model context.
 *
 * Two entry points because Codex only tolerates ONE JSON object on a hook's
 * stdout, and the hivemind SessionStart hook already emits its own:
 *
 *   - `renderCodexChannels` — pure; returns the two channel strings so the
 *     hook can merge them into its single JSON object. This is the path
 *     production uses (see src/hooks/codex/session-start.ts).
 *   - `emitCodex` — writes a standalone JSON object. Used when the drain
 *     runs as its own Codex hook process (nothing else on that stdout).
 */

import type { Notification } from "../types.js";
import { renderNotifications } from "../format.js";

export interface CodexChannels {
  /** User-visible `warning:` line. Undefined when there is nothing to show. */
  systemMessage?: string;
  /** Model-visible (and user-visible) `hook context:` block. */
  additionalContext?: string;
}

export function renderCodexChannels(notifications: Notification[]): CodexChannels {
  if (notifications.length === 0) return {};
  const modelSafe = notifications.filter(n => !n.userVisibleOnly);
  const modelRendered = renderNotifications(modelSafe);
  const userRendered = renderNotifications(notifications);
  return {
    ...(userRendered ? { systemMessage: userRendered } : {}),
    ...(modelRendered ? { additionalContext: modelRendered } : {}),
  };
}

export function emitCodex(notifications: Notification[]): void {
  const { systemMessage, additionalContext } = renderCodexChannels(notifications);
  if (!systemMessage && !additionalContext) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      ...(additionalContext ? { additionalContext } : {}),
    },
    ...(systemMessage ? { systemMessage } : {}),
  }));
}
