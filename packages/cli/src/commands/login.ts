import { buildCommand } from "@stricli/core";
import { CAPABILITY_SCOPES } from "@webhook-co/contract";
import { orgSlugErrorMessage, redactSecret, validateOrgSlug } from "@webhook-co/shared";

import {
  createApiClient,
  DEFAULT_API_BASE_URL,
  ENV_API_URL_VAR,
  resolveApiBaseUrl,
} from "../api-client.js";
import { ENV_API_KEY_VAR } from "../config/env-store.js";
import type { AppContext } from "../context.js";
import { InvalidOrgSlugError, MissingApiKeyError } from "../errors.js";
import {
  announceActiveProfile,
  globalFlags,
  resolveGlobals,
  resolveProfile,
  type GlobalFlags,
} from "../global-flags.js";
import { sanitizeControl } from "../output/safe-text.js";
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
  // `org` is inherited from GlobalFlags. On `login` it's a LOGIN HINT (which org to authenticate into),
  // NOT the global org→profile selector — the credential doesn't exist locally yet, so login bypasses that
  // resolution (see resolveLoginProfile) and instead forwards the slug as the `/authorize` `organization`
  // hint + defaults the profile name to it.
}

/** The org-slug login hint (`--org <slug>`), or undefined when unset/empty. */
function loginOrgHint(flags: LoginFlags): string | undefined {
  // Trim so `--org " acme"` (a padded shell var) is treated like `org use " acme"` — both resolve `acme`,
  // rather than the login path alone rejecting it via validateOrgSlug.
  const trimmed = flags.org?.trim();
  return trimmed !== undefined && trimmed !== "" ? trimmed : undefined;
}

/** True when the login profile was DERIVED from `--org` (a slug, no explicit `--profile`). Such a login
 *  should also make that profile ACTIVE, so a plain follow-up command targets the org just logged into
 *  (otherwise the created profile exists but resolution still falls back to default). */
function loginProfileIsOrgDerived(flags: LoginFlags): boolean {
  const explicitProfile = flags.profile !== undefined && flags.profile !== "";
  return !explicitProfile && loginOrgHint(flags) !== undefined;
}

/**
 * Resolve the profile name for a login. `--org` is a login HINT here, so we bypass the global org→profile
 * selector (there's no local credential to match yet) and instead default the profile to the org slug when
 * the user named an org but no explicit `--profile`. Precedence: `--profile` › `--org` slug › the usual
 * env/active/default fallback.
 */
async function resolveLoginProfile(ctx: AppContext, flags: LoginFlags): Promise<string> {
  const explicitProfile =
    flags.profile !== undefined && flags.profile !== "" ? flags.profile : undefined;
  const profileName = explicitProfile ?? loginOrgHint(flags);
  // Pass only `profile` (never `org`) so resolveProfile does NOT run the org selector — just the
  // reserved-name guard + the env/active/default fallback when profileName is undefined.
  return resolveProfile(ctx, { profile: profileName });
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
    /** The org slug the user asked to log into (`--org`), for the requested-vs-actual mismatch warning. */
    orgHint?: string;
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

  // Persist the org the SERVER bound at consent (from the /token body), never the requested slug — the two
  // can differ if the user picked a different org on the consent screen. Warn when they do, so a login that
  // silently landed on another org is visible. Captured here so `wbhk org list` / `--org` work offline.
  const org = opts.body.organization;
  if (org !== undefined) {
    await ctx.store.setOrg(org, opts.profile);
    if (opts.orgHint !== undefined && org.slug.toLowerCase() !== opts.orgHint.toLowerCase()) {
      ctx.process.stderr.write(
        `note: you requested org \`${sanitizeControl(opts.orgHint)}\` but consented as ` +
          `\`${sanitizeControl(org.slug)}\` — the credential is bound to \`${sanitizeControl(org.slug)}\`.\n`,
      );
    }
  }
  // An `--org`-derived profile becomes the ACTIVE profile, so a plain follow-up command targets the org
  // just logged into (mirrors what a user expects after `wbhk login --org acme`).
  if (loginProfileIsOrgDerived(flags)) await ctx.store.setActiveProfile?.(opts.profile);

  const { format } = resolveGlobals(ctx, flags);
  const handle = redactCredential(cred); // total over the union; the refresh token is never shown
  if (format === "json") {
    ctx.process.stdout.write(
      renderJson({
        orgId: identity.orgId,
        ...(identity.userId !== undefined ? { userId: identity.userId } : {}),
        ...(org !== undefined ? { org } : {}),
        scopes: identity.scopes,
        key: handle,
        persisted: true,
        method: `oauth (${opts.authMethod})`,
      }) + "\n",
    );
    return;
  }
  const via = opts.authMethod === "device" ? "via device" : "via browser";
  // Echo the bound org (slug + name) when the server returned one; otherwise the orgId, as before.
  const target =
    org !== undefined
      ? `${sanitizeControl(org.slug)} (${sanitizeControl(org.name)})`
      : identity.orgId;
  ctx.process.stdout.write(`logged in to ${target} ${via} (${handle})\n`);
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
  const profile = await resolveLoginProfile(ctx, flags);
  announceActiveProfile(ctx, profile);
  const orgHint = loginOrgHint(flags);
  const { apiBaseUrl, authBaseUrl } = await resolveOAuthEndpoints(ctx, flags, profile);
  const { body, clientId } = await loopbackLogin({
    fetch: ctx.io.fetch,
    authBaseUrl,
    scope: OAUTH_SCOPE,
    resource: OAUTH_RESOURCE,
    organization: orgHint,
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
    orgHint,
  });
}

/** `wbhk login --device` — the RFC 8628 device flow. Throws OAuthError (denied/expired) or ApiError. */
async function runDeviceLogin(ctx: AppContext, flags: LoginFlags): Promise<void> {
  const profile = await resolveLoginProfile(ctx, flags);
  announceActiveProfile(ctx, profile);
  const orgHint = loginOrgHint(flags);
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
    organization: orgHint,
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
    orgHint,
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

  const profile = await resolveLoginProfile(ctx, flags);
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
    // The api-key path has no `/token` org, so when the user asked for one (`--org`) persist the org the
    // SERVER identified on whoami — so `wbhk … --org <slug>` resolves immediately after. Best-effort: a
    // server that doesn't enrich `organization` just leaves it to a later whoami backfill (never fails login).
    const apiKeyOrgHint = loginOrgHint(flags);
    if (apiKeyOrgHint !== undefined) {
      const serverOrg = identity.organization;
      if (serverOrg !== undefined) {
        await ctx.store.setOrg(serverOrg, profile);
        // Parity with the OAuth path: warn when the profile is named after the requested slug but the server
        // bound a DIFFERENT org (the credential is bound to the server's org, not the requested one).
        if (serverOrg.slug.toLowerCase() !== apiKeyOrgHint.toLowerCase()) {
          ctx.process.stderr.write(
            `note: you requested org \`${sanitizeControl(apiKeyOrgHint)}\` but the server reports ` +
              `\`${sanitizeControl(serverOrg.slug)}\` — the credential is bound to \`${sanitizeControl(serverOrg.slug)}\`.\n`,
          );
        }
      } else {
        // The server didn't enrich the org, so the profile named after the slug has NO bound org yet — say
        // so rather than leave it silently org-less; the next `wbhk whoami` backfills it.
        ctx.process.stderr.write(
          `note: could not capture the org for \`${sanitizeControl(apiKeyOrgHint)}\` from the server — ` +
            "it will be recorded on the next `wbhk whoami`.\n",
        );
      }
    }
    // An `--org`-derived profile becomes the ACTIVE profile (parity with the OAuth path).
    if (loginProfileIsOrgDerived(flags)) await ctx.store.setActiveProfile?.(profile);
  }

  const { format } = resolveGlobals(ctx, flags);
  const handle = redactSecret(key);
  const org = identity.organization;
  if (format === "json") {
    ctx.process.stdout.write(
      renderJson({
        orgId: identity.orgId,
        ...(identity.userId !== undefined ? { userId: identity.userId } : {}),
        ...(org !== undefined ? { org } : {}),
        scopes: identity.scopes,
        key: handle,
        persisted: source !== "env",
      }) + "\n",
    );
    return;
  }
  const note = source === "env" ? " (via WBHK_API_KEY; not persisted)" : "";
  const target =
    org !== undefined
      ? `${sanitizeControl(org.slug)} (${sanitizeControl(org.name)})`
      : identity.orgId;
  ctx.process.stdout.write(`logged in to ${target} (${handle})${note}\n`);
}

export const loginCommand = buildCommand<LoginFlags, [], AppContext>({
  async func(this: AppContext, flags) {
    // Validate the `--org` hint LOCALLY before any network call — a malformed slug fails fast (a friendly
    // usage error) and nothing is sent. Uses the shared, single-sourced slug rules + per-reason messages.
    const orgHint = loginOrgHint(flags);
    if (orgHint !== undefined) {
      const check = validateOrgSlug(orgHint);
      if (!check.ok) return new InvalidOrgSlugError(orgHint, orgSlugErrorMessage(check.reason));
    }
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
