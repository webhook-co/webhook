"use server";

import { CAPABILITY_SCOPES } from "@webhook-co/contract/capability";

import { mintApiKey } from "./credential-mint";
import { revokeGrantById, revokeKeyById } from "./credential-revoke";
import type { ApiKeyItem } from "./credentials";
import { verifySession } from "./session";

/**
 * Surface the real cause of an otherwise-swallowed action failure to Workers observability — scrubbed:
 * the error name/message + (for a PG error) its SQLSTATE code, never a key/plaintext/pepper or a row
 * value. The user still gets a generic message; this keeps a credential-mutation failure diagnosable
 * instead of silent (a silent `catch {}` is what hid the `(void 0) is not a function` bundling bug).
 * (Not exported — "use server" files may only export async actions.)
 */
function logActionError(event: string, error: unknown): void {
  const e = error as { name?: string; message?: string; code?: string };
  console.error(
    JSON.stringify({
      message: event,
      name: e?.name,
      error: e?.message ?? String(error),
      code: e?.code,
    }),
  );
}

export interface CreateKeyInput {
  readonly name: string;
  readonly scopes: readonly string[];
}

export type CreateKeyResult =
  | { readonly ok: true; readonly key: ApiKeyItem; readonly plaintext: string }
  | { readonly ok: false; readonly error: string };

/**
 * Create a standalone API key. The plaintext is returned **once**, only as this client-action result —
 * it is never SSR'd, persisted, or logged; the caller surfaces it once and then keeps only the redacted
 * `key.start`. Mints + writes the `key_minted` audit atomically via Lane B (see {@link mintApiKey}),
 * under withTenant(session.orgId) as webhook_app, keyed by the session principal as the audit actor.
 *
 * Scopes are narrowed server-side to the grantable CAPABILITY_SCOPES — a client can never widen a key
 * beyond them (e.g. the reserved `keys:manage` is dropped).
 */
export async function createApiKey(input: CreateKeyInput): Promise<CreateKeyResult> {
  const session = await verifySession();

  const name = input.name.trim();
  if (!name) return { ok: false, error: "Give the key a name." };

  const grantable = new Set<string>(CAPABILITY_SCOPES);
  const scopes = input.scopes.filter((s) => grantable.has(s));
  if (scopes.length === 0) return { ok: false, error: "Choose at least one scope." };

  try {
    const created = await mintApiKey({
      orgId: session.orgId,
      userId: session.userId,
      name,
      scopes,
    });
    const key: ApiKeyItem = {
      id: created.id,
      name: created.name,
      start: created.start,
      scopes: created.scopes,
      createdAt: new Date(),
      lastUsedAt: null,
      expiresAt: created.expiresAt,
      revokedAt: null,
    };
    return { ok: true, key, plaintext: created.plaintext };
  } catch (error) {
    logActionError("credential.create_failed", error);
    return { ok: false, error: "We couldn't create the key. Please try again." };
  }
}

export type RevokeResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

/**
 * Revoke a standalone API key under withTenant(session.orgId) as webhook_app (Lane B stamps revoked_at +
 * writes the audit, returns the key hash) and evicts KV_AUTHZ so the key stops authenticating — immediately
 * on a successful evict, otherwise within the credential-cache TTL (eviction is best-effort over the
 * source-of-truth DB stamp; see {@link revokeKeyById}). `{ok:false}` means the DB revoke itself failed —
 * not a stale cache. Idempotent — re-revoking an already-revoked key revokes nothing and evicts nothing.
 */
export async function revokeApiKey(keyId: string): Promise<RevokeResult> {
  const session = await verifySession();
  if (!keyId.trim()) return { ok: false, error: "Missing key id." };
  try {
    await revokeKeyById({ orgId: session.orgId, userId: session.userId, keyId });
    return { ok: true };
  } catch (error) {
    logActionError("credential.revoke_key_failed", error);
    return { ok: false, error: "We couldn't revoke the key. Please try again." };
  }
}

/**
 * Revoke a device grant. The revoke **cascades** to every key minted under it (Lane B returns the
 * cascaded `revokedKeyHashes`), and each is evicted from KV_AUTHZ (best-effort over the durable DB stamp —
 * any entry that fails to evict lapses within the credential-cache TTL; see {@link revokeGrantById}). The
 * caller reflects the cascade in the UI (the grant + its child keys all read revoked).
 */
export async function revokeGrant(grantId: string): Promise<RevokeResult> {
  const session = await verifySession();
  if (!grantId.trim()) return { ok: false, error: "Missing grant id." };
  try {
    await revokeGrantById({ orgId: session.orgId, userId: session.userId, grantId });
    return { ok: true };
  } catch (error) {
    logActionError("credential.revoke_grant_failed", error);
    return { ok: false, error: "We couldn't revoke. Please try again." };
  }
}
