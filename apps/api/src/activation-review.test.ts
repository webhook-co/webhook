import type { ActivationWeeklyReviewRow } from "@webhook-co/db";
import { describe, expect, it, vi } from "vitest";

import { handleActivationReview, type ActivationReviewDep } from "./activation-review.js";

// The internal founder-only activation weekly-review endpoint. Fail-closed at every step: unconfigured → 404,
// missing/wrong token → 401, only a matching token returns the aggregate series. The token compare is
// constant-time (SHA-256 both sides). Aggregate-only — no org_id, no PII.

const ROW: ActivationWeeklyReviewRow = {
  isoWeek: "2026-07-13",
  signups: 5,
  reachedCapture: 4,
  reachedForward: 3,
  activatedOrgs: 2,
  activationRate: 0.6,
  ttfvMedianHours: 1.5,
  ttfvP90Hours: 12,
};

const dep = (over: Partial<ActivationReviewDep> = {}): ActivationReviewDep => ({
  token: vi.fn(async () => "s3cr3t-review-token"),
  read: vi.fn(async () => [ROW]),
  ...over,
});

const req = (auth?: string): Request =>
  new Request("https://api.webhook.co/v1/internal/activation/weekly", {
    headers: auth ? { authorization: auth } : {},
  });

describe("handleActivationReview", () => {
  it("404s (dark) when the endpoint is unconfigured (no dep)", async () => {
    const res = await handleActivationReview(req("Bearer s3cr3t-review-token"), undefined);
    expect(res.status).toBe(404);
  });

  it("404s (dark) when the token secret is bound but empty (misconfigured)", async () => {
    const d = dep({ token: vi.fn(async () => "") });
    const res = await handleActivationReview(req("Bearer anything"), d);
    expect(res.status).toBe(404);
    expect(d.read).not.toHaveBeenCalled();
  });

  it("401s with no Authorization header", async () => {
    const d = dep();
    const res = await handleActivationReview(req(), d);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
    expect(d.read).not.toHaveBeenCalled();
  });

  it("401s on a wrong token (and never reads)", async () => {
    const d = dep();
    const res = await handleActivationReview(req("Bearer wrong-token"), d);
    expect(res.status).toBe(401);
    expect(d.read).not.toHaveBeenCalled();
  });

  it("401s on a token that is a prefix of the real one (constant-time, not startsWith)", async () => {
    const d = dep();
    const res = await handleActivationReview(req("Bearer s3cr3t"), d);
    expect(res.status).toBe(401);
  });

  it("200s with the aggregate weekly series on the correct token", async () => {
    const d = dep();
    const res = await handleActivationReview(req("Bearer s3cr3t-review-token"), d);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ weeks: [ROW] });
    expect(d.read).toHaveBeenCalledTimes(1);
  });
});
