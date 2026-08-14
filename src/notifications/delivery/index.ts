/**
 * Per-agent delivery dispatch. Each adapter receives a rendered plain-text
 * notification block and writes it in whatever shape that agent's harness
 * surfaces to the user without concatenating into the existing memory/hivemind
 * block.
 *
 * Today only Claude Code has a real adapter. Other agents (Codex, Cursor,
 * Hermes, Pi, openclaw) will be added one at a time — each addition is:
 *   1. New file `src/notifications/delivery/<agent>.ts` exporting an emit
 *   2. Add the agent string to the `Agent` union in `../types.ts`
 *   3. Wire it into the ADAPTERS map below
 *
 * See `../AGENT_CHANNELS.md` for the research on per-agent harness
 * behavior — that's the forward reference for what each new adapter
 * needs to do.
 */

import type { Agent, Notification } from "../types.js";
import { emitClaudeCode } from "./claude-code.js";
import { emitCodex } from "./codex.js";
import { renderModelChannelContext } from "./model-channel.js";
import { renderNotifications } from "../format.js";

// Adapters now take notifications, not a pre-rendered string, so each
// agent can decide per-channel rendering (e.g. user-visible-only items
// are kept out of Claude Code's model-visible additionalContext). The
// previous string-based signature collapsed both channels to the same
// content, which leaked LLM-derived insight prose into the model's
// system prompt (codex P1).
export type EmitFn = (notifications: Notification[]) => void;

const ADAPTERS: Record<Agent, EmitFn> = {
  "claude-code": emitClaudeCode,
  // Codex's SessionStart hook already owns its stdout, so production passes
  // a `deliver` override (see DrainOptions) and merges the rendered channels
  // into its own JSON object. This adapter is the standalone-process path.
  codex: emitCodex,
  // Cursor's session-start hook owns its single JSON object and appends the
  // rendered context itself (see src/hooks/cursor/session-start.ts), so
  // production always passes a `deliver` override. This adapter is the
  // standalone-process path.
  // Hermes delivers from its pre_llm_call capture hook (no user-visible
  // session-start channel exists), always via a `deliver` override.
  hermes: (notifications) => {
    const context = renderModelChannelContext(notifications);
    if (context) process.stdout.write(JSON.stringify({ context }));
  },
  // Pi is the one non-Claude-Code harness with a real user-visible channel
  // (ctx.ui.notify). Its extension spawns src/hooks/pi/notifications-worker.ts
  // and calls notify() per item, so delivery always goes through a `deliver`
  // override; this adapter is the standalone-process path.
  pi: (notifications) => {
    // No empty-guard: emit() already returns early on an empty batch, and
    // renderNotifications of a non-empty batch is always non-empty. (Cursor
    // and Hermes DO need one — their renderer can filter everything out.)
    const text = renderNotifications(notifications);
    process.stdout.write(JSON.stringify({ notifications: [{ text, severity: "warning" }] }));
  },
  cursor: (notifications) => {
    const context = renderModelChannelContext(notifications);
    if (!context) return;
    process.stdout.write(JSON.stringify({ additional_context: context }));
  },
};

export function emit(agent: Agent, notifications: Notification[]): void {
  if (notifications.length === 0) return;
  ADAPTERS[agent](notifications);
}
