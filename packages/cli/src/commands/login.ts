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
import { loopbackLogin } from "../oauth/loopback-login.js";
import { toOAuthCredential, type FrozenTokenBody } from "../oauth/token-client.js";
import { redactCredential, renderJson } from "../output/format.js";

// `wbhk login` — authenticate and persist a credential for future commands.
//   • default (interactive): the RFC 8252 loopback BROWSER OAuth flow — opens a browser, you approve, the
//     code is captured on a localhost redirect, and the minted OAuth credential is persisted (the access
//     token then refreshes silently — see the token manager).
//   • `--device`: the RFC 8628 device flow — a code + verification URL; works headless / on a remote box.
//   • `--api-key`: an interactive hidden api-key prompt (NEVER an argv flag — that leaks into shell history
//     + `ps`). `--stdin` reads a key piped in; `WBHK_API_KEY` is the never-persisted headless path.
//   Every credential is validated via the identity endpoint BEFORE anything is written, so a bad one
//   stores nothing.

interface LoginFlags extends GlobalFlags {
  stdin: boolean;
  apiKey: boolean;
  device: boolean;
  insecureStorage: boolean;
  authUrl?: string;
}

// OAuth login targets the hosted api; the minted key's audience is server-bound from approval regardless,
// so `resource` is advisory. Scopes are the canonical capability set (an empty scope → invalid_scope).
const OAUTH_RESOURCE = DEFAULT_API_BASE_URL;
const OAUTH_SCOPE = CAPABILITY_SCOPES.join(" ");
/** The device-flow DCR registration needs a valid loopback redirect literal even though the device flow
 *  never uses it (no browser redirect). A port-less 127.0.0.1 literal is accepted by `/register`. */
const DEVICE_REDIRECT_URI = "http://127.0.0.1/callback";

/** Validate a freshly minted OAuth credential (a bad token stores nothing — mirrors the api-key path)
 *  then persist it + report. Shared by the loopback (browser) + device flows. */
async function persistOAuthLogin(
  ctx: AppContext,
  flags: LoginFlags,
  opts: {
    profile: string;
    apiBaseUrl: string;
    body: FrozenTokenBody;
    clientId: string;
    authMethod: "loopback" | "device";
  },
): Promise<void> {
  const cred = toOAuthCredential(opts.body, {
    authMethod: opts.authMethod,
    clientId: opts.clientId,
    now: Date.now(),
  });
  const identity = await createApiClient({
    baseUrl: opts.apiBaseUrl,
    apiKey: cred.oauth.accessKey,
    fetch: ctx.io.fetch,
  }).whoami();
  await ctx.store.set(cred, opts.profile, { allowInsecure: flags.insecureStorage });
  if (flags.apiUrl !== undefined) await ctx.store.setApiBaseUrl(opts.apiBaseUrl, opts.profile);

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
        method: `oauth (${opts.authMethod})`,
      }) + "\n",
    );
    return;
  }
  const via = opts.authMethod === "device" ? "via device" : "via browser";
  ctx.process.stdout.write(`logged in to ${identity.orgId} ${via} (${handle})\n`);
}

/** Resolve the api base + issuer for an OAuth flow (shared by loopback + device). */
async function resolveOAuthEndpoints(
  ctx: AppContext,
  flags: LoginFlags,
  profile: string,
): Promise<{ apiBaseUrl: string; authBaseUrl: string }> {
  return {
    apiBaseUrl: resolveApiBaseUrl({
      flag: flags.apiUrl,
      env: ctx.process.env?.[ENV_API_URL_VAR],
      stored: await ctx.store.getApiBaseUrl(profile),
    }),
    authBaseUrl: resolveAuthBaseUrl({
      flag: flags.authUrl,
      env: ctx.process.env?.[ENV_AUTH_URL_VAR],
    }),
  };
}

/** `wbhk login` (default, interactive) — the RFC 8252 loopback browser flow. Throws OAuthError / ApiError. */
async function runLoopbackLogin(ctx: AppContext, flags: LoginFlags): Promise<void> {
  const profile = await resolveProfile(ctx, flags);
  announceActiveProfile(ctx, profile);
  const { apiBaseUrl, authBaseUrl } = await resolveOAuthEndpoints(ctx, flags, profile);
  const { body, clientId } = await loopbackLogin({
    fetch: ctx.io.fetch,
    authBaseUrl,
    scope: OAUTH_SCOPE,
    resource: OAUTH_RESOURCE,
    startLoopbackServer: () => ctx.io.startLoopbackServer(),
    openBrowser: (url) => ctx.io.openBrowser(url),
    emit: (line) => ctx.process.stderr.write(line),
  });
  await persistOAuthLogin(ctx, flags, {
    profile,
    apiBaseUrl,
    body,
    clientId,
    authMethod: "loopback",
  });
}

/** `wbhk login --device` — the RFC 8628 device flow. Throws OAuthError (denied/expired) or ApiError. */
async function runDeviceLogin(ctx: AppContext, flags: LoginFlags): Promise<void> {
  const profile = await resolveProfile(ctx, flags);
  announceActiveProfile(ctx, profile);
  const { apiBaseUrl, authBaseUrl } = await resolveOAuthEndpoints(ctx, flags, profile);
  // Register a fresh public client per login (the device redirect is unused; a port-less literal serves).
  const { clientId } = await registerClient(
    { fetch: ctx.io.fetch },
    oauthEndpoints(authBaseUrl).register,
    [DEVICE_REDIRECT_URI],
  );
  const body = await deviceLogin({
    fetch: ctx.io.fetch,
    authBaseUrl,
    clientId,
    scope: OAUTH_SCOPE,
    resource: OAUTH_RESOURCE,
    sleep: (ms) => ctx.io.sleep(ms),
    emit: (line) => ctx.process.stderr.write(line),
    openBrowser: (url) => ctx.io.openBrowser(url),
    now: () => Date.now(),
  });
  await persistOAuthLogin(ctx, flags, {
    profile,
    apiBaseUrl,
    body,
    clientId,
    authMethod: "device",
  });
}

type KeySource = "stdin" | "env" | "prompt";

/** Resolve the API key + where it came from, or a MissingApiKeyError. `--stdin` (pipe) › `WBHK_API_KEY`
 *  (headless env) › `--api-key` (interactive hidden prompt). Only called on the api-key path. */
async function resolveKey(
  ctx: AppContext,
  flags: LoginFlags,
): Promise<{ key: string; source: KeySource } | MissingApiKeyError> {
  if (flags.stdin) {
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
  // --api-key: the interactive hidden prompt.
  if (!ctx.io.isInteractive) {
    return new MissingApiKeyError(
      "--api-key needs an interactive terminal — pipe a key with --stdin or set WBHK_API_KEY for headless use.",
    );
  }
  const key = await ctx.io.promptSecret("api key: ");
  return key === "" ? new MissingApiKeyError("no api key entered.") : { key, source: "prompt" };
}

/** The api-key flow: validate the key BEFORE persisting; the WBHK_API_KEY env path is never persisted. */
async function runApiKeyLogin(
  ctx: AppContext,
  flags: LoginFlags,
): Promise<void | MissingApiKeyError> {
  const resolved = await resolveKey(ctx, flags);
  if (resolved instanceof MissingApiKeyError) return resolved;
  const { key, source } = resolved;

  const profile = await resolveProfile(ctx, flags);
  announceActiveProfile(ctx, profile);
  const baseUrl = resolveApiBaseUrl({
    flag: flags.apiUrl,
    env: ctx.process.env?.[ENV_API_URL_VAR],
    stored: await ctx.store.getApiBaseUrl(profile),
  });
  // Validate BEFORE persisting — a rejected key (ApiError) propagates and nothing is stored.
  const identity = await createApiClient({ baseUrl, apiKey: key, fetch: ctx.io.fetch }).whoami();

  // WBHK_API_KEY is the never-persisted headless path; only an interactively/piped key is saved.
  if (source !== "env") {
    // Persist to the OS keychain (secure) by default; --insecure-storage forces the 0600 file even
    // under WBHK_REQUIRE_SECURE_STORAGE (the escape hatch for a box without a keychain helper).
    await ctx.store.set({ apiKey: key }, profile, { allowInsecure: flags.insecureStorage });
    // Make the base URL sticky too — but ONLY when explicitly overridden, so a plain `login` never
    // overwrites a stored value. The env-only path above persists nothing, base URL included.
    if (flags.apiUrl !== undefined) await ctx.store.setApiBaseUrl(baseUrl, profile);
  }

  const { format } = resolveGlobals(ctx, flags);
  const handle = redactSecret(key);
  if (format === "json") {
    ctx.process.stdout.write(
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
  ctx.process.stdout.write(`logged in to ${identity.orgId} (${handle})${note}\n`);
}

export const loginCommand = buildCommand<LoginFlags, [], AppContext>({
  async func(this: AppContext, flags) {
    if (flags.device) return runDeviceLogin(this, flags);
    // The api-key path is taken when explicitly requested (`--stdin` / `--api-key`) or when the headless
    // WBHK_API_KEY override is set; otherwise `login` defaults to the interactive browser (loopback) flow.
    const envKey = this.process.env?.[ENV_API_KEY_VAR];
    const hasEnvKey = envKey !== undefined && envKey !== "";
    if (flags.stdin || flags.apiKey || hasEnvKey) return runApiKeyLogin(this, flags);
    // Default: the browser flow needs a TTY to open a browser + wait on a local redirect.
    if (!this.io.isInteractive) {
      return new MissingApiKeyError(
        "no credential source for a headless run — use --device, pipe a key with --stdin, or set WBHK_API_KEY.",
      );
    }
    return runLoopbackLogin(this, flags);
  },
  parameters: {
    flags: {
      ...globalFlags,
      apiKey: {
        kind: "boolean",
        brief: "authenticate with an api key via an interactive prompt (instead of the browser)",
        default: false,
      },
      stdin: { kind: "boolean", brief: "read the api key from stdin (for piping)", default: false },
      device: {
        kind: "boolean",
        brief: "authenticate via the OAuth device flow (a code + URL; for a headless/remote box)",
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
        brief: "override the OAuth issuer URL (for the browser + device flows)",
        optional: true,
      },
    },
  },
  docs: {
    brief: "authenticate (browser by default; --device or --api-key) and store the credential",
  },
});
