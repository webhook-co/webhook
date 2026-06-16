// Read a secret that is bound either as a Cloudflare Secrets Store binding (an async `.get()`) or —
// in local dev / tests — injected as a plain string. Call sites stay agnostic to the source: in prod
// the three Workers bind `secrets_store_secrets` (so `env.X` is a `SecretsStoreSecret`); the workerd
// test suite injects plain strings via miniflare `bindings`. This deliberately avoids seeding a local
// Secrets Store for tests (the miniflare `secretsStoreSecrets` option maps a binding but carries no
// value — workers-sdk #9369), keeping the suite hermetic with the existing string injection.

/** Resolve a secret from a Secrets Store binding (`.get()`) or a plain-string injection (as-is). */
export async function readSecretBinding(secret: SecretsStoreSecret | string): Promise<string> {
  return typeof secret === "string" ? secret : secret.get();
}
