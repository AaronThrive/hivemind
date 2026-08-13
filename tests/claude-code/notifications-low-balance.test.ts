import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for src/notifications/sources/low-balance.ts.
 *
 * The behavior under test is precisely the one that failed in production:
 * a user whose org is under $2 saw the top-up warning only *sometimes*
 * (reported 2026-08-12 in #platform). The warning used to ride on the
 * primary banner, so it inherited every reason the banner had to stay
 * quiet. These cases pin it to the balance and nothing else.
 *
 * Mocked at the network boundary only — `fetchBalanceCents` reads a real
 * `Response`'s headers, so the fetch spy returns real Response objects.
 */

const fetchMock = vi.fn();
vi.stubGlobal("fetch", (...a: any[]) => fetchMock(...a));
vi.mock("../../src/utils/debug.js", () => ({ log: () => undefined }));

const { pickLowBalanceNotice, LOW_BALANCE_THRESHOLD_CENTS } =
  await import("../../src/notifications/sources/low-balance.js");

const CREDS = {
  token: "tok", orgId: "org-1", orgName: "acme",
  userName: "alice", workspaceId: "ws-1",
  apiUrl: "https://api.example.test",
} as any;

function balanceResp(cents: string | null, status = 200): Response {
  const headers: Record<string, string> = {};
  if (cents !== null) headers["X-Activeloop-Balance-Cents"] = cents;
  return new Response(JSON.stringify({ org: {}, user: {} }), { status, headers });
}

beforeEach(() => { fetchMock.mockReset(); });

describe("pickLowBalanceNotice", () => {
  it("warns with the exact remaining amount and an org-scoped billing link", async () => {
    fetchMock.mockResolvedValue(balanceResp("113"));
    const n = await pickLowBalanceNotice(CREDS);
    expect(n).not.toBeNull();
    expect(n!.id).toBe("balance-low");
    expect(n!.severity).toBe("warn");
    expect(n!.title).toBe("Hivemind balance low — top up to avoid interruption");
    expect(n!.body).toBe(
      "Only $1.13 of prepaid credit left. "
      + "Top up at https://deeplake.ai/acme/workspace/ws-1/billing "
      + "before capture and memory recall start failing.",
    );
    // Billing copy is for the human; it must never enter the model's context.
    expect(n!.userVisibleOnly).toBe(true);
    // Self-clearing: once topped up no fresh notice is produced, so recording
    // it in state.shown would only block a later genuine re-warning.
    expect(n!.transient).toBe(true);
  });

  it("does NOT depend on a session id or on the session being a fresh startup", async () => {
    // The regression: pickPrimaryBanner returns null for resumes and for a
    // missing session_id, which silently swallowed the warning. This source
    // takes neither as input, so there is no such gate to inherit.
    fetchMock.mockResolvedValue(balanceResp("50"));
    expect(pickLowBalanceNotice.length).toBe(1);
    const n = await pickLowBalanceNotice(CREDS);
    expect(n!.body).toContain("$0.50");
  });

  it("stays silent when the balance is healthy", async () => {
    fetchMock.mockResolvedValue(balanceResp(String(LOW_BALANCE_THRESHOLD_CENTS)));
    expect(await pickLowBalanceNotice(CREDS)).toBeNull();
    fetchMock.mockResolvedValue(balanceResp("5000"));
    expect(await pickLowBalanceNotice(CREDS)).toBeNull();
  });

  it("stays silent at or below zero — that is the 402 balance-exhausted path", async () => {
    // Both notices firing would double up on the same problem.
    fetchMock.mockResolvedValue(balanceResp("0"));
    expect(await pickLowBalanceNotice(CREDS)).toBeNull();
    fetchMock.mockResolvedValue(balanceResp("-500"));
    expect(await pickLowBalanceNotice(CREDS)).toBeNull();
  });

  it("stays silent — never guesses — when the header is absent or malformed", async () => {
    fetchMock.mockResolvedValue(balanceResp(null));
    expect(await pickLowBalanceNotice(CREDS)).toBeNull();
    fetchMock.mockResolvedValue(balanceResp("not-a-number"));
    expect(await pickLowBalanceNotice(CREDS)).toBeNull();
  });

  it("reads the balance off an error response too (a 402 carries the zero balance)", async () => {
    fetchMock.mockResolvedValue(balanceResp("42", 402));
    const n = await pickLowBalanceNotice(CREDS);
    expect(n!.body).toContain("$0.42");
  });

  it("never throws when the network fails, and makes no request when logged out", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await pickLowBalanceNotice(CREDS)).toBeNull();

    fetchMock.mockReset();
    expect(await pickLowBalanceNotice(null)).toBeNull();
    expect(await pickLowBalanceNotice({ ...CREDS, token: "" })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bypasses the org-stats cache — the balance is read fresh every time", async () => {
    // The 1h org-stats cache is why a balance that dropped mid-hour stayed
    // invisible. Two consecutive calls must produce two requests.
    fetchMock.mockResolvedValue(balanceResp("120"));
    await pickLowBalanceNotice(CREDS);
    await pickLowBalanceNotice(CREDS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.example.test/me/hivemind-stats");
  });
});
