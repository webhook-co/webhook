import { buildCommand } from "@stricli/core";
import { CAPABILITY_SCOPES } from "@webhook-co/contract";
import { redactSecret } from "@webhook-co/shared";

import {
  createApiClient,
  DEFAULT_API_BASE_URL,
  ENV_API_URL_VAR,
  resolveApiBaseUrl,
} from "../api-client.js";
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
import { registerClient } from "../oauth/dcr.js";
import { deviceLogin } from "../oauth/device-login.js";
import { ENV_AUTH_URL_VAR, oauthEndpoints, resolveAuthBaseUrl } from "../oauth/endpoints.js";
import { toOAuthCredential } from "../oauth/token-client.js";
import { redactCredential, renderJson } from "../output/format.js";

// `wbhk login` — authenticate and persist a credential for future commands.
//   • default / `--stdin`: capture an API KEY (piped, WBHK_API_KEY env, or an interactive hidden prompt —
//     NEVER an argv flag, which leaks into shell history + `ps`), validate it via the identity endpoint
//     BEFORE writing (a bad key stores nothing), then persist. WBHK_API_KEY is the never-persisted path.
//   • `--device`: the RFC 8628 OAuth device flow — register a public client (DCR), show a user code +
//     verification URL (best-effort opening the browser), poll until approval, then persist the minted
//     OAuth credential (the access token refreshes silently — see the token manager). The browser-based
//     loopback flow is a separate slice; `--device` works headlessly + on a remote box.

interface LoginFlags extends GlobalFlags {
  stdin: boolean;
  insecureStorage: boolean;
  device: boolean;
  authUrl?: string;
}

/** The device-flow DCR registration needs a valid loopback redirect literal even though the device flow
 *  itself never uses it (no browser redirect). A port-less 127.0.0.1 literal is accepted by `/register`. */
const DEVICE_REDIRECT_URI = "http://127.0.0.1/callback";

/** `wbhk login --device` — the RFC 8628 device flow. Throws OAuthError (denied/expired) or ApiError. */
async function runDeviceLogin(ctx: AppContext, flags: LoginFlags): Promise<void> {
  const profile = await resolveProfile(ctx, flags);
  announceActiveProfile(ctx, profile);
  const apiBaseUrl = resolveApiBaseUrl({
    flag: flags.apiUrl,
    env: ctx.process.env?.[ENV_API_URL_VAR],
    stored: await ctx.store.getApiBaseUrl(profile),
  });
  const authBaseUrl = resolveAuthBaseUrl({
    flag: flags.authUrl,
    env: ctx.process.env?.[ENV_AUTH_URL_VAR],
  });
  // Register a fresh public client per login. (Caching a client_id is incompatible with the loopback
  // flow's per-port redirect anyway; the device flow's redirect is unused, so a port-less literal serves.)
  const { clientId } = await registerClient(
    { fetch: ctx.io.fetch },
    oauthEndpoints(authBaseUrl).register,
    [DEVICE_REDIRECT_URI],
  );
  const body = await deviceLogin({
    fetch: ctx.io.fetch,
    authBaseUrl,
    clientId,
    scope: CAPABILITY_SCOPES.join(" "),
    // OAuth login targets the hosted api; the audience is server-bound from approval regardless.
    resource: DEFAULT_API_BASE_URL,
    sleep: (ms) => ctx.io.sleep(ms),
    emit: (line) => ctx.process.stderr.write(line),
    openBrowser: (url) => ctx.io.openBrowser(url),
    now: () => Date.now(),
  });
  const cred = toOAuthCredential(body, { authMethod: "device", clientId, now: Date.now() });
  // Validate before persisting (mirrors the api-key path): a bad token stores nothing.
  const identity = await createApiClient({
    baseUrl: apiBaseUrl,
    apiKey: cred.oauth.accessKey,
    fetch: ctx.io.fetch,
  }).whoami();
  await ctx.store.set(cred, profile, { allowInsecure: flags.insecureStorage });
  if (flags.apiUrl !== undefined) await ctx.store.setApiBaseUrl(apiBaseUrl, profile);

  const { format } = resolveGlobals(ctx, flags);
  const handle = redactCredential(cred); // total over the union; the refresh token is never shown
  if (format === "json") {
    ctx.process.stdout.write(
      renderJson({
        orgId: identity.orgId,
        ...(identity.userId !== undefined ? { userId: identity.userId } : {}),
        scopes: identity.scopes,
        key: handle,
        persisted: true,
        method: "oauth (device)",
      }) + "\n",
    );
    return;
  }
  ctx.process.stdout.write(`logged in to ${identity.orgId} via device (${handle})\n`);
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
    if (flags.device) return runDeviceLogin(this, flags);
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
      device: {
        kind: "boolean",
        brief:
          "authenticate via the OAuth device flow (a code + URL; works on a headless/remote box)",
        default: false,
      },
      insecureStorage: {
        kind: "boolean",
        brief: "store the credential in the 0600 config file instead of the OS keychain",
        default: false,
      },
      authUrl: {
        kind: "parsed",
        parse: (value: string) => value,
        brief: "override the OAuth issuer URL (for --device)",
        optional: true,
      },
    },
  },
  docs: { brief: "authenticate (api key, or --device for OAuth) and store the credential" },
});
