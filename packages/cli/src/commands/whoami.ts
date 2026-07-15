import { buildCommand } from "@stricli/core";

import { createApiClient, ENV_API_URL_VAR, resolveApiBaseUrl } from "../api-client.js";
import { ENV_API_KEY_VAR } from "../config/env-store.js";
import { isOAuthCredential } from "../config/schema.js";
import type { AppContext } from "../context.js";
import { NotLoggedInError } from "../errors.js";
import {
  announceActiveProfile,
  displayFlags,
  hasEnvApiKey,
  resolveGlobals,
  resolveProfile,
  type DisplayFlags,
} from "../global-flags.js";
import { bindAuth } from "../oauth/auth-binding.js";
import { redactCredential, renderJson } from "../output/format.js";
import { sanitizeControl } from "../output/safe-text.js";

// `wbhk whoami` — show the authenticated principal. Reads the stored credential (env › file), calls
// the identity endpoint to resolve + validate it, and prints the org, scopes, and a redacted key
// handle. A missing credential is NotLoggedInError; a server 401 (revoked/expired) surfaces as the
// ApiError from the client. The full key is never printed (only `redactSecret`).

type WhoamiFlags = DisplayFlags;

export const whoamiCommand = buildCommand<WhoamiFlags, [], AppContext>({
  async func(this: AppContext, flags) {
    // whoami is DIAGNOSTIC — it reports who the ACTIVE credential is — so it resolves PROFILE-ONLY and does
    // NOT carry `--org` (see displayFlags). This keeps it a reliable recovery command: a stale ambient
    // WBHK_ORG can never brick "who am I?", and WBHK_API_KEY (whose identity whoami legitimately reports)
    // works untouched. To inspect a specific login, use `--profile`.
    const profile = await resolveProfile(this, flags);
    announceActiveProfile(this, profile);
    const cred = await this.store.get(profile);
    if (cred === null) return new NotLoggedInError();

    const baseUrl = resolveApiBaseUrl({
      flag: flags.apiUrl,
      env: this.process.env?.[ENV_API_URL_VAR],
      stored: await this.store.getApiBaseUrl(profile),
    });
    const { bearer, refreshAuth } = await bindAuth({
      cred,
      profile,
      store: this.store,
      fetch: this.io.fetch,
      env: this.process.env,
    });
    const client = createApiClient({ baseUrl, apiKey: bearer, fetch: this.io.fetch, refreshAuth });
    const identity = await client.whoami(); // throws ApiError (a CliError) on 401/etc — handled by the app

    // Where the active credential actually came from — resolved ONCE (single getWithSource call), used both
    // to guard the org backfill and to report the source below. `hasEnvApiKey` is the shared env-cred
    // primitive (the same guard authedClient/listen/replay use via isEnvCredential); combined with the real
    // backend ("keychain" | "file") from getWithSource it gives `fromEnv` without a second store read. An
    // inline test fake without getWithSource falls back to the generic "stored credential".
    const envKeyPresent = hasEnvApiKey(this);
    const backendSource = this.store.getWithSource
      ? (await this.store.getWithSource(profile))?.source
      : undefined;
    const fromEnv = envKeyPresent || backendSource === "env";
    const source = envKeyPresent
      ? `env (${ENV_API_KEY_VAR})`
      : (backendSource ?? "stored credential");

    // The org the credential is bound to (token = org). The SERVER's whoami is authoritative — it names the
    // org by slug even for a profile that predates local org metadata (e.g. an api-key login) — so it takes
    // precedence over the local profile copy, which is the offline fallback.
    const localOrg = await this.store.getOrg(profile);
    const serverOrg = identity.organization;
    // For an ENV credential, the local profile's stored org does NOT describe it (the env key is bound to a
    // server-side org), so NEVER fall back to localOrg — show only what the server named (or nothing). A
    // profile credential may legitimately show its cached local org when the server omits it.
    const org = fromEnv ? serverOrg : (serverOrg ?? localOrg);
    // Lazily backfill the local cache when the server names an org the local copy is missing or disagrees
    // with — but ONLY for a STORED credential (file/keychain). NEVER for the WBHK_API_KEY env path: that
    // credential has no persisted profile, so a setOrg would write a PHANTOM org onto the credential-less
    // `default` file profile. Best-effort: a backfill write must never fail `whoami`.
    if (
      !fromEnv &&
      serverOrg &&
      (localOrg?.id !== serverOrg.id ||
        localOrg?.slug !== serverOrg.slug ||
        localOrg?.name !== serverOrg.name)
    ) {
      try {
        await this.store.setOrg(serverOrg, profile);
      } catch {
        // Best-effort cache refresh; whoami still reports the server truth below.
      }
    }

    const { format } = resolveGlobals(this, flags);
    // Total over the credential union; the OAuth refresh token is never displayed.
    const handle = redactCredential(cred);
    // The auth method (api-key vs which OAuth flow). CLI-derived (trusted, no sanitize).
    const method = isOAuthCredential(cred) ? `oauth (${cred.oauth.authMethod})` : "api-key";
    if (format === "json") {
      // userId is present only for a user principal (OAuth tokens later); omit it for org-scoped keys.
      this.process.stdout.write(
        renderJson({
          orgId: identity.orgId,
          ...(identity.userId !== undefined ? { userId: identity.userId } : {}),
          ...(org !== undefined ? { org } : {}),
          scopes: identity.scopes,
          key: handle,
          method,
          source,
        }) + "\n",
      );
      return;
    }
    // orgId/userId/scopes are server-controlled (z.string()) — sanitize before the text view so a
    // hostile value can't inject a terminal escape. (`handle`/`method`/`source` are CLI-derived — trusted.)
    const scopes =
      identity.scopes.length > 0
        ? identity.scopes.map((s) => sanitizeControl(s)).join(", ")
        : "(none)";
    const userLine =
      identity.userId !== undefined ? `user: ${sanitizeControl(identity.userId)}\n` : "";
    // The bound org by slug + name (server truth, else local), shown under the orgId when known.
    const boundOrgLine =
      org !== undefined
        ? `bound org: ${sanitizeControl(org.slug)} (${sanitizeControl(org.name)})\n`
        : "";
    this.process.stdout.write(
      `org: ${sanitizeControl(identity.orgId)}\n${boundOrgLine}${userLine}key: ${handle}\n` +
        `method: ${method}\nsource: ${source}\nscopes: ${scopes}\n`,
    );
  },
  parameters: {
    flags: { ...displayFlags },
  },
  docs: { brief: "show the authenticated org, scopes, and key handle" },
});
