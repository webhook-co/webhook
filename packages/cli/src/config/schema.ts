import { z } from "zod";

// The on-disk CLI config is versioned and profile-keyed (forward-compatible: multiple
// orgs/environments without a schema break). A profile holds an optional API base URL and
// a single stored credential; `activeProfile` records the persisted default selection.
// Validated with zod at the read boundary so a corrupt or tampered file is a typed error,
// never a silent misparse.

export const CONFIG_VERSION = 2 as const;
export const DEFAULT_PROFILE = "default" as const;

export const StoredCredentialSchema = z.object({
  apiKey: z.string().min(1),
});
export type StoredCredential = z.infer<typeof StoredCredentialSchema>;

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
  return cfg;
}
