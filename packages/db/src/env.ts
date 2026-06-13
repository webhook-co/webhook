// Connection-string resolution for Node contexts (migrations, tests, local dev
// scripts). In Workers the connection string comes from the Hyperdrive binding
// (env.HYPERDRIVE_TENANT.connectionString) and is passed to createClient directly;
// this helper is for the Node side only.
//
// The local vs dev vs prod distinction is a binding/connection-string swap, not a
// code fork: the same data-access code runs everywhere. Prod and dev never share a
// connection string (separate Neon projects).

import { createCredentialHasher, type CredentialHasher } from "./credential";

const VAR = "DATABASE_URL";

export function resolveDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env[VAR];
  if (!url || url.trim() === "") {
    throw new Error(
      `${VAR} is not set. Local dev/tests get it from the ephemeral-Postgres harness; ` +
        `dev/prod come from per-environment Hyperdrive bindings (separate Neon projects).`,
    );
  }
  return url;
}

const PEPPER_VAR = "CREDENTIAL_PEPPER";
const PEPPER_PREVIOUS_VAR = "CREDENTIAL_PEPPER_PREVIOUS";

/**
 * Build the credential hasher from the environment. CREDENTIAL_PEPPER is the active pepper
 * (base64, >=32 bytes), injected as a wrangler/Worker secret — NEVER committed to source
 * and never stored in a DB column (same custody as the audit-chain key, ADR-0004).
 * CREDENTIAL_PEPPER_PREVIOUS is an optional comma-separated list of older peppers still
 * accepted during a rotation window. The pepper is REQUIRED: there is no insecure default,
 * so a misconfigured environment fails loud rather than silently minting bare-sha256 hashes.
 */
export function resolveCredentialHasher(env: NodeJS.ProcessEnv = process.env): CredentialHasher {
  const current = decodePepper(env[PEPPER_VAR], PEPPER_VAR);
  const previous = (env[PEPPER_PREVIOUS_VAR] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .map((b64, i) => decodePepper(b64, `${PEPPER_PREVIOUS_VAR}[${i}]`));
  return createCredentialHasher({ current, previous });
}

function decodePepper(value: string | undefined, name: string): Buffer {
  if (!value || value.trim() === "") {
    throw new Error(
      `${name} is not set. The credential pepper is injected as a wrangler/Worker secret ` +
        `(base64, >=32 bytes) and must never be committed to source.`,
    );
  }
  const trimmed = value.trim();
  // Node's base64 decoder is LENIENT: it silently drops characters it doesn't recognise,
  // so a typo'd / wrong-format pepper (whitespace, base64url vs base64 confusion, a stray
  // character) would decode to a wrong-but-accepted buffer and quietly change every hash.
  // Validate strict standard base64 first and fail loud instead.
  if (trimmed.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) {
    throw new Error(
      `${name} is not valid base64. The credential pepper is injected as a wrangler/Worker ` +
        `secret (standard base64, >=32 bytes) and must never be committed to source.`,
    );
  }
  return Buffer.from(trimmed, "base64");
}
