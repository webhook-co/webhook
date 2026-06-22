import { buildCommand } from "@stricli/core";

import { ENV_API_KEY_VAR } from "../config/env-store.js";
import { isOAuthCredential } from "../config/schema.js";
import type { AppContext } from "../context.js";
import {
  announceActiveProfile,
  globalFlags,
  resolveProfile,
  type GlobalFlags,
} from "../global-flags.js";
import { ENV_AUTH_URL_VAR, oauthEndpoints, resolveAuthBaseUrl } from "../oauth/endpoints.js";
import { revokeToken } from "../oauth/revoke.js";

// `wbhk logout` — clear the stored credential for the active profile. For an OAuth credential, the
// refresh token is ALSO revoked server-side (RFC 7009; the server cascades to the access key + evicts the
// authz cache) so a logged-out token stops working everywhere — best-effort: a revoke failure still
// clears the local credential. An API-KEY credential is only cleared LOCALLY (it may be a shared,
// dashboard-issued key the user didn't mint and shouldn't revoke from here). A WBHK_API_KEY in the env
// isn't stored, so it can't be erased — we say so.

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

interface LogoutFlags extends GlobalFlags {
  authUrl?: string;
}

export const logoutCommand = buildCommand<LogoutFlags, [], AppContext>({
  async func(this: AppContext, flags) {
    const profile = await resolveProfile(this, flags);
    announceActiveProfile(this, profile);
    const cred = await this.store.get(profile);
    if (cred === null) {
      this.process.stderr.write("not logged in — nothing to do.\n");
      return;
    }

    const wasOAuth = isOAuthCredential(cred);
    if (isOAuthCredential(cred)) {
      const authBase = resolveAuthBaseUrl({
        flag: flags.authUrl,
        env: this.process.env?.[ENV_AUTH_URL_VAR],
      });
      try {
        await revokeToken(
          { fetch: this.io.fetch },
          oauthEndpoints(authBase).revoke,
          cred.oauth.refreshToken,
        );
      } catch (err) {
        this.process.stderr.write(
          `could not revoke server-side (${errMsg(err)}) — clearing the local credential anyway.\n`,
        );
      }
    }

    await this.store.erase(profile);
    // An env credential (WBHK_API_KEY) lives in the environment, not the store — erase can't remove it,
    // and the env backend outranks the store, so the user is still authenticated. Don't claim a clean
    // logout: report honestly that erase cleared any on-disk credential but the env var still grants access.
    if ((this.process.env?.[ENV_API_KEY_VAR] ?? "").length > 0) {
      this.process.stdout.write(
        "cleared the stored credential, but WBHK_API_KEY is still set in your environment — " +
          "unset it to fully log out.\n",
      );
      return;
    }
    this.process.stdout.write(`logged out${wasOAuth ? " (token revoked)" : ""}.\n`);
  },
  parameters: {
    flags: {
      ...globalFlags,
      authUrl: {
        kind: "parsed",
        parse: (value: string) => value,
        brief: "override the OAuth issuer URL (for the token revoke)",
        optional: true,
      },
    },
  },
  docs: { brief: "log out: revoke the OAuth token (if any) and clear the stored credential" },
});
