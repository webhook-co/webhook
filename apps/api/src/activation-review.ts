// The internal founder-only activation weekly-review endpoint (activation follow-up). NOT a public
// capability — deliberately kept OUT of the OpenAPI spec/SDKs (it returns platform-wide aggregates), so the
// router matches it directly before the spec-driven `matchRoute`. Token-gated with a constant-time compare
// against `INTERNAL_REVIEW_TOKEN`; reads via the least-privilege `webhook_activation_reviewer` Hyperdrive
// (the fn is aggregate-only — no org_id, no PII). Absent config → 404 (ships dark), wrong/missing token → 401.

import type { ActivationWeeklyReviewRow } from "@webhook-co/db";

import { extractBearer } from "./auth.js";

/** Route-specific dep, bound ONLY by apps/api. Present only when BOTH the reviewer Hyperdrive binding and the
 *  token secret exist; absent → the endpoint is 404 (dark). `token` resolves the gating secret lazily (only
 *  when the route is hit — never on the capability hot path); `read` opens the reviewer connection + returns
 *  the weekly series (injected so the router/handler is testable without a DB). */
export interface ActivationReviewDep {
  readonly token: () => Promise<string>;
  readonly read: () => Promise<ActivationWeeklyReviewRow[]>;
}

/** Constant-time token comparison. Both sides are SHA-256'd first, so the compare is always over equal-length
 *  (32-byte) digests and leaks neither the token length nor an early-mismatch position. Uses WebCrypto
 *  (workerd-native). */
async function tokensMatch(provided: string, expected: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [pa, pb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(provided)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  const a = new Uint8Array(pa);
  const b = new Uint8Array(pb);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

const notFound = (): Response =>
  new Response("not found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });

/**
 * Handle `GET /v1/internal/activation/weekly`. Fail-closed at every step: no dep (unconfigured) → 404; an
 * empty resolved token (misconfigured secret) → 404; missing/wrong Bearer → 401; only a matching token
 * returns the aggregate weekly series as `{ weeks: [...] }`.
 */
export async function handleActivationReview(
  request: Request,
  dep: ActivationReviewDep | undefined,
): Promise<Response> {
  if (!dep) return notFound();
  const expected = await dep.token();
  if (!expected) return notFound(); // secret bound but empty → treat as unconfigured (dark)
  const provided = extractBearer(request);
  if (provided === null || !(await tokensMatch(provided, expected))) {
    return new Response(null, { status: 401, headers: { "www-authenticate": "Bearer" } });
  }
  return Response.json({ weeks: await dep.read() });
}
