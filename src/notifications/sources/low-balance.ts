/**
 * Low-balance notice — "you have $X left, top up before requests fail".
 *
 * Previously this was a rider on the primary banner (`appendBalance` in
 * primary-banner.ts), which made it fire only *sometimes*. Four independent
 * gates could swallow it, none of them related to the balance itself:
 *
 *   1. `pickPrimaryBanner` returns null on `source === "resume"` — every
 *      resumed session dropped the warning.
 *   2. It returns null when the hook gets no `session_id`.
 *   3. It returns null for logged-out users (fine) but ALSO short-circuits
 *      to the cold-start brief before any balance check.
 *   4. The balance rode on `fetchOrgStats`, which is cached for an hour —
 *      so within an hour of a healthy read, a balance that had since
 *      dropped stayed invisible.
 *
 * A billing warning must not depend on whether a welcome banner happened to
 * render. This source owns it: it makes its own uncached balance read and
 * returns a standalone notification, so the only thing that decides whether
 * the user is warned is the balance.
 *
 * Scope is the SOFT warning (0 < balance < threshold). Hard exhaustion
 * (balance ≤ 0) is owned by the 402 path in deeplake-api.ts, which enqueues
 * `balance-exhausted` — surfacing both would double up.
 */

import type { Credentials } from "../../commands/auth-creds.js";
import type { Notification } from "../types.js";
import { fetchBalanceCents } from "./balance.js";
import { log as _log } from "../../utils/debug.js";

const log = (msg: string) => _log("notifications-low-balance", msg);

/** Below this prepaid balance (cents) we warn. Mirrors the SDK's
 *  LOW_BALANCE_THRESHOLD_CENTS. */
export const LOW_BALANCE_THRESHOLD_CENTS = 200;

/** Org-scoped billing page. Keyed on the org ID: `orgName` is a display name
 *  ("mvincig11's Organization"), not a slug, and produced a broken link. See
 *  deeplake-api.ts billingUrl() for the full reasoning. */
export function billingUrl(creds: Credentials): string {
  if (creds.orgId && creds.workspaceId) {
    return `https://deeplake.ai/${encodeURIComponent(creds.orgId)}/workspace/${encodeURIComponent(creds.workspaceId)}/billing`;
  }
  return "https://deeplake.ai";
}

/**
 * Returns the balance notice for THIS session, or null when the balance is
 * healthy, unknown, or the user is logged out.
 *
 * Two outcomes, both decided from one live read:
 *   • balance <= 0  → "credits exhausted"
 *   • 0 < balance < threshold → "balance low"
 *
 * The exhausted case is checked live here, not only via the 402 queue path in
 * deeplake-api. The queue is written when a 402 fires and drained at the NEXT
 * SessionStart, which produced three user-visible failures:
 *   1. You run out of credits and the session that broke tells you nothing —
 *      you find out one session later, if at all.
 *   2. The queue is shared across agents and drained once, so whichever agent
 *      starts next consumes it and the other never shows it.
 *   3. A notice enqueued under one org renders after you switch to another,
 *      naming the wrong org and linking to the wrong billing page.
 * A live read is scoped to the credentials in force right now, so it says the
 * right thing in the session it applies to. The queue path stays as the
 * fallback for when the balance read itself fails.
 *
 * dedupKey carries the balance so a user working through a draining balance
 * sees the number move, while repeated hook fires within one session collapse
 * to one emission.
 */
export async function pickLowBalanceNotice(
  creds: Credentials | null | undefined,
): Promise<Notification | null> {
  if (!creds?.token) return null;
  const balanceCents = await fetchBalanceCents(creds);
  if (balanceCents === null) {
    log("balance unknown — no notice");
    return null;
  }
  if (balanceCents <= 0) {
    log(`balance exhausted (${balanceCents}c) — emitting live notice`);
    return {
      id: "balance-exhausted",
      severity: "warn",
      transient: true,
      title: "Hivemind credits exhausted — top up to keep capturing",
      body: "Sessions are not being saved and memory recall is returning empty. "
        + `Top up at ${billingUrl(creds)} to restore capture and recall.`,
      dedupKey: { reason: "balance-zero" },
      userVisibleOnly: true,
    };
  }
  if (balanceCents >= LOW_BALANCE_THRESHOLD_CENTS) return null;
  log(`balance low (${balanceCents}c) — emitting notice`);
  return {
    id: "balance-low",
    severity: "warn",
    // Self-clearing: the balance read IS the rate limit. Once topped up, no
    // fresh notice is produced, so recording it in state.shown would only
    // block a later, genuine re-warning.
    transient: true,
    title: "Hivemind balance low — top up to avoid interruption",
    body: `Only $${(balanceCents / 100).toFixed(2)} of prepaid credit left. `
      + `Top up at ${billingUrl(creds)} before capture and memory recall start failing.`,
    dedupKey: { balanceCents },
    // Billing copy is for the human, not the model's context.
    userVisibleOnly: true,
  };
}
