/**
 * Uncached read of the org's prepaid balance.
 *
 * The balance rides on the `X-Activeloop-Balance-Cents` response header of
 * `/me/hivemind-stats`. `fetchOrgStats` also reads that endpoint, but it
 * caches for an hour — correct for a savings recap, wrong for a billing
 * warning: within that hour a balance that dropped below the threshold
 * stayed invisible, which is why the low-balance warning only appeared
 * *sometimes*. This read deliberately bypasses that cache.
 *
 * Never throws. Returns null when the user is logged out, the request
 * fails or times out, or the header is missing/malformed — callers treat
 * null as "unknown" and stay silent rather than guess.
 */

import type { Credentials } from "../../commands/auth-creds.js";
import { log as _log } from "../../utils/debug.js";

const log = (msg: string) => _log("notifications-balance", msg);

const FETCH_TIMEOUT_MS = 1500;
const DEFAULT_API_URL = "https://api.deeplake.ai";

/** Response header carrying the org's current prepaid balance, in cents. */
export const BALANCE_HEADER = "X-Activeloop-Balance-Cents";

export function parseBalanceHeader(headers: Headers | undefined): number | null {
  const raw = headers?.get?.(BALANCE_HEADER);
  if (!raw || !/^-?\d+$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  return Number.isFinite(n) ? n : null;
}

export async function fetchBalanceCents(creds: Credentials | null): Promise<number | null> {
  if (!creds?.token) return null;
  const apiUrl = creds.apiUrl ?? DEFAULT_API_URL;
  const url = `${apiUrl}/me/hivemind-stats`;
  const ctrl = new AbortController();
  const timeoutHandle = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${creds.token}`,
        ...(creds.orgId ? { "X-Activeloop-Org-Id": creds.orgId } : {}),
      },
      signal: ctrl.signal,
    });
    // The header is present on error responses too (a 402 carries the zero
    // balance that caused it), so we read it regardless of status.
    const cents = parseBalanceHeader(resp.headers);
    log(`balance read from ${url}: ${cents === null ? "unknown" : `${cents}c`} (status ${resp.status})`);
    return cents;
  } catch (e: any) {
    log(`balance read failed: ${e?.message ?? String(e)}`);
    return null;
  } finally {
    clearTimeout(timeoutHandle);
  }
}
