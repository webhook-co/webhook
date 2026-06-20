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
