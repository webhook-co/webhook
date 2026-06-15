import { z } from "zod";

// The on-disk CLI config is versioned and profile-keyed (forward-compatible: multiple
// orgs/environments without a schema break). A profile holds an optional API base URL and
// a single stored credential. Validated with zod at the read boundary so a corrupt or
// tampered file is a typed error, never a silent misparse.

export const CONFIG_VERSION = 1 as const;
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
  profiles: z.record(z.string(), ProfileSchema),
});
export type ConfigFile = z.infer<typeof ConfigFileSchema>;

export function emptyConfig(): ConfigFile {
  return { version: CONFIG_VERSION, profiles: {} };
}
