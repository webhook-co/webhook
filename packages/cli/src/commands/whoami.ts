import { buildCommand } from "@stricli/core";

import { createApiClient, ENV_API_URL_VAR, resolveApiBaseUrl } from "../api-client.js";
import { ENV_API_KEY_VAR } from "../config/env-store.js";
import { credentialAccessToken, isOAuthCredential } from "../config/schema.js";
import type { AppContext } from "../context.js";
import { NotLoggedInError } from "../errors.js";
import {
  announceActiveProfile,
  globalFlags,
  resolveGlobals,
  resolveProfile,
  type GlobalFlags,
} from "../global-flags.js";
import { redactCredential, renderJson } from "../output/format.js";
import { sanitizeControl } from "../output/safe-text.js";

// `wbhk whoami` — show the authenticated principal. Reads the stored credential (env › file), calls
// the identity endpoint to resolve + validate it, and prints the org, scopes, and a redacted key
// handle. A missing credential is NotLoggedInError; a server 401 (revoked/expired) surfaces as the
// ApiError from the client. The full key is never printed (only `redactSecret`).

type WhoamiFlags = GlobalFlags;

export const whoamiCommand = buildCommand<WhoamiFlags, [], AppContext>({
  async func(this: AppContext, flags) {
    const profile = await resolveProfile(this, flags);
    announceActiveProfile(this, profile);
    const cred = await this.store.get(profile);
    if (cred === null) return new NotLoggedInError();

    const baseUrl = resolveApiBaseUrl({
      flag: flags.apiUrl,
      env: this.process.env?.[ENV_API_URL_VAR],
      stored: await this.store.getApiBaseUrl(profile),
    });
    const client = createApiClient({
      baseUrl,
      apiKey: credentialAccessToken(cred),
      fetch: this.io.fetch,
    });
    const identity = await client.whoami(); // throws ApiError (a CliError) on 401/etc — handled by the app

    const { format } = resolveGlobals(this, flags);
    // Total over the credential union; the OAuth refresh token is never displayed.
    const handle = redactCredential(cred);
    // The auth method (api-key vs which OAuth flow) and where the credential came from. The env
    // backend has highest read precedence (env-store.ts), so a non-empty WBHK_API_KEY IS the active
    // credential — report it as the source. All values here are CLI-derived (trusted, no sanitize).
    const method = isOAuthCredential(cred) ? `oauth (${cred.oauth.authMethod})` : "api-key";
    const source =
      (this.process.env?.[ENV_API_KEY_VAR] ?? "").length > 0
        ? `env (${ENV_API_KEY_VAR})`
        : "stored credential";
    if (format === "json") {
      // userId is present only for a user principal (OAuth tokens later); omit it for org-scoped keys.
      this.process.stdout.write(
        renderJson({
          orgId: identity.orgId,
          ...(identity.userId !== undefined ? { userId: identity.userId } : {}),
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
    this.process.stdout.write(
      `org: ${sanitizeControl(identity.orgId)}\n${userLine}key: ${handle}\n` +
        `method: ${method}\nsource: ${source}\nscopes: ${scopes}\n`,
    );
  },
  parameters: {
    flags: { ...globalFlags },
  },
  docs: { brief: "show the authenticated org, scopes, and key handle" },
});
