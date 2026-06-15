import { buildCommand } from "@stricli/core";
import { redactSecret } from "@webhook-co/shared";

import { createApiClient, ENV_API_URL_VAR, resolveApiBaseUrl } from "../api-client.js";
import type { AppContext } from "../context.js";
import { NotLoggedInError } from "../errors.js";
import { renderJson, resolveFormat, type OutputFormat } from "../output/format.js";

// `wbhk whoami` — show the authenticated principal. Reads the stored credential (env › file), calls
// the identity endpoint to resolve + validate it, and prints the org, scopes, and a redacted key
// handle. A missing credential is NotLoggedInError; a server 401 (revoked/expired) surfaces as the
// ApiError from the client. The full key is never printed (only `redactSecret`).

interface WhoamiFlags {
  output: OutputFormat;
  apiUrl?: string;
}

export const whoamiCommand = buildCommand<WhoamiFlags, [], AppContext>({
  async func(this: AppContext, flags) {
    const cred = await this.store.get();
    if (cred === null) return new NotLoggedInError();

    const baseUrl = resolveApiBaseUrl({
      flag: flags.apiUrl,
      env: this.process.env?.[ENV_API_URL_VAR],
      stored: await this.store.getApiBaseUrl(),
    });
    const client = createApiClient({ baseUrl, apiKey: cred.apiKey, fetch: this.io.fetch });
    const identity = await client.whoami(); // throws ApiError (a CliError) on 401/etc — handled by the app

    const handle = redactSecret(cred.apiKey);
    if (resolveFormat(flags.output) === "json") {
      // userId is present only for a user principal (OAuth tokens later); omit it for org-scoped keys.
      this.process.stdout.write(
        renderJson({
          orgId: identity.orgId,
          ...(identity.userId !== undefined ? { userId: identity.userId } : {}),
          scopes: identity.scopes,
          key: handle,
        }) + "\n",
      );
      return;
    }
    const scopes = identity.scopes.length > 0 ? identity.scopes.join(", ") : "(none)";
    const userLine = identity.userId !== undefined ? `user: ${identity.userId}\n` : "";
    this.process.stdout.write(
      `org: ${identity.orgId}\n${userLine}key: ${handle}\nscopes: ${scopes}\n`,
    );
  },
  parameters: {
    flags: {
      output: { kind: "enum", values: ["text", "json"], brief: "output format", default: "text" },
      apiUrl: {
        kind: "parsed",
        parse: (value: string) => value,
        brief: "override the API base URL",
        optional: true,
      },
    },
  },
  docs: { brief: "show the authenticated org, scopes, and key handle" },
});
