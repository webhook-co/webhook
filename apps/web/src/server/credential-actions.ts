"use server";

import { CAPABILITY_SCOPES } from "@webhook-co/contract/capability";

import type { ApiKeyItem } from "./credentials";
import { verifySession } from "./session";

export interface CreateKeyInput {
  readonly name: string;
  readonly scopes: readonly string[];
}

export type CreateKeyResult =
  | { readonly ok: true; readonly key: ApiKeyItem; readonly plaintext: string }
  | { readonly ok: false; readonly error: string };

/**
 * Create a standalone API key. The plaintext is returned **once**, only as this client-action
 * result — it is never SSR'd, persisted, or logged; the caller surfaces it once and then keeps
 * only the redacted `key.start`. E6 mints a mock secret; E8 calls Lane B's createApiKey (which
 * mints the CSPRNG secret + writes the `key_minted` audit) under withTenant(session.orgId) and
 * evicts/refreshes KV_AUTHZ.
 *
 * Scopes are narrowed server-side to the grantable CAPABILITY_SCOPES — a client can never widen
 * a key beyond them (e.g. the reserved `keys:manage` is dropped).
 */
export async function createApiKey(input: CreateKeyInput): Promise<CreateKeyResult> {
  await verifySession(); // gate; E8 uses session.orgId for the tenant-scoped mint

  const name = input.name.trim();
  if (!name) return { ok: false, error: "Give the key a name." };

  const grantable = new Set<string>(CAPABILITY_SCOPES);
  const scopes = input.scopes.filter((s) => grantable.has(s));
  if (scopes.length === 0) return { ok: false, error: "Choose at least one scope." };

  const plaintext = `whsec_${crypto.randomUUID().replace(/-/g, "")}`;
  const key: ApiKeyItem = {
    id: `key_${crypto.randomUUID().slice(0, 8)}`,
    name,
    start: `${plaintext.slice(0, 11)}…${plaintext.slice(-4)}`,
    scopes,
    createdAt: new Date(),
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
  };

  return { ok: true, key, plaintext };
}

export type RevokeResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

/**
 * Revoke a standalone API key. Mock seam: E8 calls Lane B's revokeApiKey under
 * withTenant(session.orgId) as webhook_app (it returns the key hash) and then evicts KV_AUTHZ via
 * resolver.invalidateHash(hash) so the key stops authenticating immediately. Idempotent —
 * re-revoking an already-revoked key is a no-op.
 */
export async function revokeApiKey(keyId: string): Promise<RevokeResult> {
  await verifySession(); // gate; E8 uses session.orgId for the tenant-scoped revoke
  if (!keyId.trim()) return { ok: false, error: "Missing key id." };
  return { ok: true };
}

/**
 * Revoke a device grant. The revoke **cascades** to every key minted under it. Mock seam: E8 calls
 * Lane B's revokeGrant under withTenant (it returns the cascaded `revokedKeyHashes`) and evicts
 * KV_AUTHZ for each one. The caller reflects the cascade in the UI (the grant + its child keys all
 * read revoked).
 */
export async function revokeGrant(grantId: string): Promise<RevokeResult> {
  await verifySession();
  if (!grantId.trim()) return { ok: false, error: "Missing grant id." };
  return { ok: true };
}
