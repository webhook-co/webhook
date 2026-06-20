import { z } from "zod";

// The C↔E consent contract (Lane C A3). Lane C's /authorize handler SSRs a ConsentRequest into Lane E's
// consent screen; the screen POSTs a ConsentDecision back. Promoted here (the shared source of truth) from
// the apps/auth consent-form mock at the A3 wire-up so both the producer (Lane C) and the renderer (Lane E)
// type against one definition.
//
// Durations: the screen shows BOTH the grant lifetime AND the minted key's TTL (founder call) — so the
// contract carries `grantExpiresAt` (the ~90d refresh/grant ceiling, ISO 8601) AND `keyTtlSeconds` (the
// ~24h access-key TTL), not a single ambiguous `expiresAt`.

/** The grant-summary Lane C's /authorize SSRs; the screen renders it read-only (no per-scope checklist). */
export const ConsentRequestSchema = z.object({
  /** Opaque id of this pending authorization; echoed back with the decision. */
  requestId: z.string(),
  /** Single-use anti-CSRF token bound to this request + the auth session; echoed with the decision. */
  csrfToken: z.string(),
  /** Which flow asked for consent. Loopback PKCE still shows this screen (deliberate-grant model). */
  flow: z.enum(["pkce_loopback", "device_code"]),
  /** The requesting client, by display name (never just the opaque client_id). */
  client: z.object({ id: z.string(), name: z.string() }),
  /** Present for the device-code flow: the device the user-code was entered on. */
  device: z.object({ name: z.string() }).optional(),
  /** The org the grant is for (the consenting user's active org). */
  org: z.object({ id: z.string(), name: z.string() }),
  /** Where the request originates — a trust signal. `location` is best-effort and may be null. */
  origin: z.object({ ip: z.string(), location: z.string().nullable() }),
  /** The requested capability scopes — rendered as a read-only summary. */
  scopes: z.array(z.string()),
  /** The resource the resulting token is audience-bound to (e.g. "https://api.webhook.co"). */
  audience: z.string(),
  /** ISO 8601 — when the GRANT (the ~90d refresh lifetime ceiling) expires if approved. */
  grantExpiresAt: z.string(),
  /** The minted access key's TTL in seconds (~24h) — shown alongside the grant lifetime. */
  keyTtlSeconds: z.number().int().positive(),
});
export type ConsentRequest = z.infer<typeof ConsentRequestSchema>;

/** The decision the consent screen POSTs back to Lane C's /authorize decision endpoint. */
export const ConsentDecisionSchema = z.object({
  requestId: z.string().min(1),
  csrfToken: z.string().min(1),
  decision: z.enum(["approve", "deny"]),
});
export type ConsentDecision = z.infer<typeof ConsentDecisionSchema>;
