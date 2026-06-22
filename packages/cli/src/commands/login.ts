import { buildCommand } from "@stricli/core";
import { redactSecret } from "@webhook-co/shared";

import { createApiClient, ENV_API_URL_VAR, resolveApiBaseUrl } from "../api-client.js";
import { ENV_API_KEY_VAR } from "../config/env-store.js";
import type { AppContext } from "../context.js";
import { MissingApiKeyError } from "../errors.js";
import {
  announceActiveProfile,
  globalFlags,
  resolveGlobals,
  resolveProfile,
  type GlobalFlags,
} from "../global-flags.js";
import { renderJson } from "../output/format.js";

// `wbhk login` — capture an API key, validate it against the API, and persist it for future commands.
// The key is taken (in precedence order) from `--stdin` (piped), the WBHK_API_KEY env var, or an
// interactive hidden prompt — NEVER an argv flag (a key in argv leaks into shell history + `ps`).
// The key is validated via the identity endpoint BEFORE anything is written, so a bad key stores
// nothing. A key from WBHK_API_KEY is the headless, never-persisted path (env already provides it).

interface LoginFlags extends GlobalFlags {
  stdin: boolean;
  insecureStorage: boolean;
}

type KeySource = "stdin" | "env" | "prompt";

/** Resolve the API key + where it came from, or a MissingApiKeyError if none is available. */
async function resolveKey(
  ctx: AppContext,
  useStdin: boolean,
): Promise<{ key: string; source: KeySource } | MissingApiKeyError> {
  if (useStdin) {
    // Guard the footgun: `--stdin` with an interactive terminal (nothing piped) would block on EOF
    // forever. Fail fast instead of hanging with no on-screen indication.
    if (ctx.io.isInteractive) {
      return new MissingApiKeyError("--stdin expects the key piped in, but stdin is a terminal.");
    }
    const key = await ctx.io.readStdin();
    return key === ""
      ? new MissingApiKeyError("no api key received on stdin.")
      : { key, source: "stdin" };
  }
  const envKey = ctx.process.env?.[ENV_API_KEY_VAR];
  if (envKey !== undefined && envKey !== "") return { key: envKey, source: "env" };
  if (ctx.io.isInteractive) {
    const key = await ctx.io.promptSecret("api key: ");
    return key === "" ? new MissingApiKeyError("no api key entered.") : { key, source: "prompt" };
  }
  return new MissingApiKeyError(
    "no api key provided — pipe it with --stdin, set WBHK_API_KEY, or run interactively.",
  );
}

export const loginCommand = buildCommand<LoginFlags, [], AppContext>({
  async func(this: AppContext, flags) {
    const resolved = await resolveKey(this, flags.stdin);
    if (resolved instanceof MissingApiKeyError) return resolved;
    const { key, source } = resolved;

    const profile = await resolveProfile(this, flags);
    announceActiveProfile(this, profile);
    const baseUrl = resolveApiBaseUrl({
      flag: flags.apiUrl,
      env: this.process.env?.[ENV_API_URL_VAR],
      stored: await this.store.getApiBaseUrl(profile),
    });
    const client = createApiClient({ baseUrl, apiKey: key, fetch: this.io.fetch });
    // Validate BEFORE persisting — a rejected key (ApiError) propagates and nothing is stored.
    const identity = await client.whoami();

    // WBHK_API_KEY is the never-persisted headless path; only an interactively/piped key is saved.
    if (source !== "env") {
      // Persist to the OS keychain (secure) by default; --insecure-storage forces the 0600 file even
      // under WBHK_REQUIRE_SECURE_STORAGE (the escape hatch for a box without a keychain helper).
      await this.store.set({ apiKey: key }, profile, { allowInsecure: flags.insecureStorage });
      // Make the base URL sticky too — but ONLY when explicitly overridden, so a plain `login` never
      // overwrites a stored value. Persist the validated, normalized URL (so a later read re-validates
      // the same clean origin). The env-only path above persists nothing, base URL included.
      if (flags.apiUrl !== undefined) await this.store.setApiBaseUrl(baseUrl, profile);
    }

    const { format } = resolveGlobals(this, flags);
    const handle = redactSecret(key);
    if (format === "json") {
      // The same {orgId, scopes, key} identity shape whoami emits, plus login's persisted flag.
      this.process.stdout.write(
        renderJson({
          orgId: identity.orgId,
          ...(identity.userId !== undefined ? { userId: identity.userId } : {}),
          scopes: identity.scopes,
          key: handle,
          persisted: source !== "env",
        }) + "\n",
      );
      return;
    }
    const note = source === "env" ? " (via WBHK_API_KEY; not persisted)" : "";
    this.process.stdout.write(`logged in to ${identity.orgId} (${handle})${note}\n`);
  },
  parameters: {
    flags: {
      ...globalFlags,
      stdin: { kind: "boolean", brief: "read the api key from stdin (for piping)", default: false },
      insecureStorage: {
        kind: "boolean",
        brief: "store the key in the 0600 config file instead of the OS keychain",
        default: false,
      },
    },
  },
  docs: { brief: "validate an api key and store it for future commands" },
});
