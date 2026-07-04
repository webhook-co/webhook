"use server";

import { revalidatePath } from "next/cache";

import type { Provider, ProviderSecretKind } from "@webhook-co/shared";

import { logActionError } from "./action-log";
import { isUuid } from "./endpoints";
import { addSecret, revokeSecret, SealerUnavailableError } from "./provider-secret-mutations";
import { verifySession } from "./session";

// The provider-secret mutation actions — the session/CSRF boundary (Next same-origin) + input guard + error
// taxonomy over the mutations seam. Authz is the session + RLS-org-pinning (any org member may manage the
// org's endpoint secrets — matching the endpoints/destinations dashboards). A provider secret is WRITE-ONLY:
// it is never returned, echoed, or logged after submit (logActionError takes the error, never the input/
// secret). The action returns only non-secret metadata ({id, provider, status}).

/**
 * The fault code of a Lane B/write-core CapabilityFault, duck-typed by `name` + `code` (not `instanceof`, so
 * it is robust across the contract-module boundary), else null. The write core throws
 * `CapabilityFault("NOT_FOUND")` for a bad/cross-org endpoint, `("VALIDATION_ERROR")` for a bad-shape secret,
 * and `("RATE_LIMITED")` at the per-endpoint cap; surfacing those distinctly keeps the dashboard at parity
 * with the api/cli/mcp error taxonomy. (Not exported — "use server" files may only export async actions.)
 */
function faultCode(error: unknown): string | null {
  const e = error as { name?: string; code?: string };
  return e?.name === "CapabilityFault" ? (e.code ?? null) : null;
}

/** The VALIDATION_ERROR message is a fixed, secret-free shape hint from the write core — safe to surface. */
function faultMessage(error: unknown): string | null {
  const e = error as { message?: string };
  return typeof e?.message === "string" ? e.message : null;
}

// Mirror the contract input bounds so the dashboard accepts exactly what api/cli/mcp accept.
const MAX_SECRET_LEN = 4096;
const MAX_LABEL_LEN = 200;
const KINDS: ReadonlySet<ProviderSecretKind> = new Set<ProviderSecretKind>([
  "signing_secret",
  "verify_token",
  "braintree_public_key",
]);

export type AddProviderSecretResult =
  | {
      readonly ok: true;
      readonly secret: { readonly id: string; readonly provider: string; readonly status: string };
    }
  | { readonly ok: false; readonly error: string };

export type ProviderSecretActionResult =
  | { readonly ok: true }
  // `gone` marks a NOT_FOUND revoke (unknown / cross-org / already-revoked / wrong-endpoint) — the secret is
  // already in its terminal state, so the UI reconciles the row to revoked rather than dead-ending on an error.
  | { readonly ok: false; readonly error: string; readonly gone?: boolean };

/**
 * Register a provider (inbound-verification) secret for an endpoint. The secret is sealed by the engine's
 * write-only sealer and NEVER returned — this action yields only metadata ({id, provider, status}). A bad
 * endpoint / secret shape / the per-endpoint cap map to distinct, honest messages (VALIDATION surfaces the
 * write core's fixed, secret-free shape hint); everything else is a generic retry.
 */
export async function addProviderSecretAction(input: {
  endpointId: string;
  provider: string;
  kind: string;
  secret: string;
  label?: string;
}): Promise<AddProviderSecretResult> {
  const session = await verifySession();

  // Runtime type guards: TS types are erased, so a crafted server-action POST can deliver non-strings —
  // coerce-guard before use so a bad payload returns a graceful error, not an unhandled 500.
  const endpointId = typeof input?.endpointId === "string" ? input.endpointId : "";
  if (!isUuid(endpointId)) return { ok: false, error: "That endpoint no longer exists." };

  const provider = typeof input?.provider === "string" ? input.provider.trim() : "";
  if (!provider) return { ok: false, error: "Choose a provider." };

  const kind = typeof input?.kind === "string" ? input.kind : "";
  if (!KINDS.has(kind as ProviderSecretKind)) return { ok: false, error: "Choose a secret type." };

  // The secret is NOT trimmed — leading/trailing bytes can be significant for a signing secret; only guard
  // presence + length. It is never logged, echoed, or stored in plaintext.
  const secret = typeof input?.secret === "string" ? input.secret : "";
  if (!secret) return { ok: false, error: "Paste the provider secret." };
  if (secret.length > MAX_SECRET_LEN) return { ok: false, error: "That secret is too long." };

  const labelRaw = typeof input?.label === "string" ? input.label.trim() : "";
  if (labelRaw.length > MAX_LABEL_LEN) {
    return { ok: false, error: `Keep the label under ${MAX_LABEL_LEN} characters.` };
  }

  try {
    const added = await addSecret({
      orgId: session.orgId,
      endpointId,
      provider: provider as Provider,
      kind: kind as ProviderSecretKind,
      secret,
      label: labelRaw || undefined,
      actor: session.userId,
    });
    // Best-effort cache bust so a subsequent navigation re-reads the list; wrapped so a revalidate throw can
    // never flip a committed add into a reported failure (the manager prepends the row optimistically too).
    try {
      revalidatePath(`/endpoints/${endpointId}`);
    } catch (revalidateError) {
      logActionError("provider_secret.revalidate_failed", revalidateError);
    }
    return { ok: true, secret: { id: added.id, provider: added.provider, status: added.status } };
  } catch (error) {
    // NEVER pass the input/secret to the scrubbed logger — only the error.
    logActionError("provider_secret.add_failed", error);
    switch (faultCode(error)) {
      case "NOT_FOUND":
        return { ok: false, error: "That endpoint no longer exists." };
      case "VALIDATION_ERROR":
        // The message is a fixed, secret-free hint describing the shape the provider/kind expects.
        return { ok: false, error: faultMessage(error) ?? "That secret isn't the expected shape." };
      case "RATE_LIMITED":
        return { ok: false, error: "This endpoint has reached its provider-secret limit." };
    }
    if (error instanceof SealerUnavailableError) {
      return { ok: false, error: "Secret storage is unavailable right now. Please try again." };
    }
    return { ok: false, error: "We couldn't save the secret. Please try again." };
  }
}

/**
 * Revoke a provider secret belonging to an endpoint — inbound webhooks signed with it stop verifying
 * immediately (the verify path drops it + the KV snapshot is evicted). `{ok:false}` on an unknown / cross-org
 * / already-revoked secret.
 */
export async function revokeProviderSecretAction(
  endpointId: string,
  secretId: string,
): Promise<ProviderSecretActionResult> {
  const session = await verifySession();
  // A non-uuid can never name a real row — treat it as gone (a clean error) rather than letting the db
  // raise 22P02 → a misleading retryable error (parity with the api/cli/mcp uuid input validation).
  if (!isUuid(endpointId) || !isUuid(secretId)) {
    return { ok: false, error: "That secret no longer exists.", gone: true };
  }
  try {
    const revoked = await revokeSecret({
      orgId: session.orgId,
      endpointId,
      secretId,
      actor: session.userId,
    });
    if (!revoked) {
      // Already gone (revoked elsewhere / cross-org / unknown): revalidate so the server list reconciles on
      // the next render, and tell the client it's `gone` so it settles the row rather than showing an error.
      try {
        revalidatePath(`/endpoints/${endpointId}`);
      } catch (revalidateError) {
        logActionError("provider_secret.revalidate_failed", revalidateError);
      }
      return { ok: false, error: "That secret no longer exists.", gone: true };
    }
    try {
      revalidatePath(`/endpoints/${endpointId}`);
    } catch (revalidateError) {
      logActionError("provider_secret.revalidate_failed", revalidateError);
    }
    return { ok: true };
  } catch (error) {
    logActionError("provider_secret.revoke_failed", error);
    return { ok: false, error: "We couldn't revoke the secret. Please try again." };
  }
}
