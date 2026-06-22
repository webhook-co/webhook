import { OAuthError } from "../errors.js";
import { sanitizeControl } from "../output/safe-text.js";
import { pollDeviceToken, requestDeviceAuthorization } from "./device.js";
import { oauthEndpoints } from "./endpoints.js";
import { type FrozenTokenBody } from "./token-client.js";

/** Only auto-open a verification URL that is on the ISSUER's own origin — a hostile/compromised issuer
 *  (reachable via `--auth-url`) must not be able to make the CLI launch an arbitrary-scheme (`file://`,
 *  custom handler) or cross-origin URL. A non-matching URL is still printed (the user can open it). */
function isIssuerOrigin(url: string, authBaseUrl: string): boolean {
  try {
    return new URL(url).origin === new URL(authBaseUrl).origin;
  } catch {
    return false;
  }
}

// The RFC 8628 device-authorization flow orchestration: request a device + user code, tell the user
// where to enter it (and best-effort open their browser), then poll `/token` until they approve. All
// wire I/O is over the injected `fetch`, and timing is over an injected `sleep` + `now`, so the whole
// flow is fake-fetch + fake-clock testable. The browser/approval round-trip is the user's; this function
// only drives the codes + the poll loop. The interactive `login --device` command wires the real io.

export interface DeviceLoginDeps {
  readonly fetch: typeof fetch;
  /** The resolved issuer origin. */
  readonly authBaseUrl: string;
  /** The DCR-registered public client id. */
  readonly clientId: string;
  /** Space-separated capability scopes to request. */
  readonly scope: string;
  /** The target audience (RFC 8707) — the api origin. */
  readonly resource: string;
  /** Backoff between polls (real `setTimeout` in prod; instant under test). */
  readonly sleep: (ms: number) => Promise<void>;
  /** Emit the user-facing authorize instructions (stderr in prod). */
  readonly emit: (line: string) => void;
  /** Best-effort: open the verification URL in the user's browser (an io seam). */
  readonly openBrowser?: (url: string) => Promise<void>;
  /** Clock for the device-code deadline (real `Date.now` in prod). */
  readonly now?: () => number;
}

/** Run the device flow to completion: returns the minted token body, or throws an OAuthError (denied /
 *  expired / an unexpected poll error). */
export async function deviceLogin(deps: DeviceLoginDeps): Promise<FrozenTokenBody> {
  const now = deps.now ?? ((): number => Date.now());
  const endpoints = oauthEndpoints(deps.authBaseUrl);
  const auth = await requestDeviceAuthorization(
    { fetch: deps.fetch },
    endpoints.deviceAuthorization,
    {
      clientId: deps.clientId,
      scope: deps.scope,
      resource: deps.resource,
    },
  );

  // verification_uri/user_code are server-controlled (only z.string()-validated); strip control bytes
  // before the stderr write so a hostile issuer can't inject a terminal escape (mirrors readOAuthError).
  deps.emit(
    `to authorize, visit ${sanitizeControl(auth.verification_uri)} and enter the code: ` +
      `${sanitizeControl(auth.user_code)}\n`,
  );
  const openUrl = auth.verification_uri_complete ?? auth.verification_uri;
  if (deps.openBrowser !== undefined && isIssuerOrigin(openUrl, deps.authBaseUrl)) {
    // Best-effort convenience — the user can always type the URL themselves, so a failure is silent.
    // Only same-origin issuer URLs are auto-opened (see isIssuerOrigin); anything else is print-only.
    try {
      await deps.openBrowser(openUrl);
    } catch {
      /* no browser available; the printed URL is the fallback */
    }
  }

  const deadlineMs = now() + auth.expires_in * 1000;
  let intervalMs = auth.interval * 1000;
  for (;;) {
    await deps.sleep(intervalMs);
    if (now() >= deadlineMs) throw new OAuthError("expired_token");
    const poll = await pollDeviceToken({ fetch: deps.fetch }, endpoints.token, {
      deviceCode: auth.device_code,
      clientId: deps.clientId,
    });
    switch (poll.kind) {
      case "token":
        return poll.body;
      case "pending":
        continue;
      case "slow_down":
        intervalMs += 5000; // the client's RFC 8628 §3.5 obligation (the poll error carries no interval)
        continue;
      case "denied":
        throw new OAuthError("access_denied");
      case "expired":
        throw new OAuthError("expired_token");
    }
  }
}
