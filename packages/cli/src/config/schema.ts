import { z } from "zod";

// The on-disk CLI config is versioned and profile-keyed (forward-compatible: multiple
// orgs/environments without a schema break). A profile holds an optional API base URL and
// a single stored credential; `activeProfile` records the persisted default selection.
// Validated with zod at the read boundary so a corrupt or tampered file is a typed error,
// never a silent misparse.

export const CONFIG_VERSION = 3 as const;
export const DEFAULT_PROFILE = "default" as const;

/** A long-lived API key (`whk_…`) entered via `wbhk login` — the original credential shape. */
export const ApiKeyCredentialSchema = z.object({
  apiKey: z.string().min(1),
});
export type ApiKeyCredential = z.infer<typeof ApiKeyCredentialSchema>;

/**
 * An OAuth credential from `wbhk login` (loopback/device): the short-lived `whk_` access key + the
 * rotating `rtk_` refresh handle + the CLI-synthesized metadata needed to refresh it. The refresh token
 * is a secret — never displayed (see redactCredential).
 */
export const OAuthCredentialSchema = z.object({
  oauth: z.object({
    accessKey: z.string().min(1), // the whk_ key — the bearer token
    refreshToken: z.string().min(1), // the rtk_ handle (NEVER displayed)
    authMethod: z.enum(["loopback", "device"]),
    expiresAt: z.number().int(), // ms epoch; = mint time + expires_in*1000
    audience: z.string().min(1), // the resource the key is bound to (e.g. https://api.webhook.co)
    clientId: z.string().min(1), // the DCR-registered client id
  }),
});
export type OAuthCredential = z.infer<typeof OAuthCredentialSchema>;

// A stored credential is EITHER a bare API key or an OAuth credential. The two variants have disjoint
// keys (`apiKey` vs `oauth`), so the union is unambiguous; the legacy `{apiKey}` shape stays valid so a
// pre-OAuth config upgrades losslessly.
export const StoredCredentialSchema = z.union([ApiKeyCredentialSchema, OAuthCredentialSchema]);
export type StoredCredential = z.infer<typeof StoredCredentialSchema>;

/** True for an OAuth credential (vs a bare API key). */
export function isOAuthCredential(cred: StoredCredential): cred is OAuthCredential {
  return "oauth" in cred;
}

/** The bearer token to send as `Authorization: Bearer …` — the `whk_` key from either variant. */
export function credentialAccessToken(cred: StoredCredential): string {
  return isOAuthCredential(cred) ? cred.oauth.accessKey : cred.apiKey;
}

export const ProfileSchema = z.object({
  apiBaseUrl: z.string().optional(),
  credential: StoredCredentialSchema.optional(),
});
export type Profile = z.infer<typeof ProfileSchema>;

export const ConfigFileSchema = z.object({
  version: z.literal(CONFIG_VERSION),
  // The persisted active profile (set by `profile use`); the resolution fallback below `--profile`/env.
  activeProfile: z.string().optional(),
  profiles: z.record(z.string(), ProfileSchema),
});
export type ConfigFile = z.infer<typeof ConfigFileSchema>;

export function emptyConfig(): ConfigFile {
  return { version: CONFIG_VERSION, profiles: {} };
}

// Forward migration ladder: read the on-disk `version` FIRST and upgrade prior versions to the current
// shape BEFORE validation, so an older config upgrades losslessly instead of failing the `version`
// literal. Each step is vN→vN+1 (never always-from-v1). An unknown/future version is left untouched →
// the schema rejects it (CorruptConfig), the safe stance for a config a newer CLI wrote. The on-disk
// upgrade is lazy: the migrated shape is written back only on the next credential/config write.
export function migrateConfigShape(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  let cfg = raw as Record<string, unknown>;
  // v1 → v2: `activeProfile` is new and optional; the profile map carries over untouched.
  if (cfg.version === 1) cfg = { ...cfg, version: 2 };
  // v2 → v3: the credential field accepts a new OAuth variant; the legacy `{apiKey}` shape stays valid,
  // so this is purely a version bump (no data transform) — a v2 config's credentials are valid v3.
  if (cfg.version === 2) cfg = { ...cfg, version: 3 };
  return cfg;
}
