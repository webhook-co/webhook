import type { ConsentRequest } from "@webhook-co/contract";

import { ConsentDecisionError, type ConsentActions } from "@/app/(auth)/consent/consent-form";
import type { DeviceActions } from "@/app/(auth)/device/device-form";

/**
 * The live impls of Lane E's consent + device seams (E8a). Both POST same-origin JSON to Lane C's
 * issuer endpoints and navigate to the `redirectTo` the server returns; on failure they throw so the
 * form surfaces its error. `application/json` is required by the endpoints (a CSRF defense: a cross-site
 * request can't set it without a preflight). `fetch`/`navigate` are injectable for tests.
 */

type Navigate = (url: string) => void;

const browserNavigate: Navigate = (url) => {
  window.location.assign(url);
};

interface ClientDeps {
  fetch?: typeof fetch;
  navigate?: Navigate;
}

async function readRedirectTo(response: Response): Promise<string> {
  const body = (await response.json()) as { redirectTo?: unknown };
  if (typeof body.redirectTo !== "string" || !body.redirectTo) {
    throw new Error("missing redirectTo");
  }
  return body.redirectTo;
}

/**
 * `POST /consent/decision { requestId, csrfToken, decision }`. The requestId (the signed ticket) and the
 * csrfToken come from the SSR'd {@link ConsentRequest}, never the user. On 200 the server returns where to
 * navigate (the OAuth callback with the code, or the client's redirect_uri with access_denied).
 */
export function makeConsentActions(
  request: Pick<ConsentRequest, "requestId" | "csrfToken">,
  deps: ClientDeps = {},
): ConsentActions {
  const doFetch = deps.fetch ?? fetch;
  const navigate = deps.navigate ?? browserNavigate;
  return {
    async decide(decision) {
      const response = await doFetch("/consent/decision", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId: request.requestId,
          csrfToken: request.csrfToken,
          decision,
        }),
      });
      // Expected dead-ends get a friendly terminal instead of the retryable error banner: 409 = already
      // approved/denied (back-button re-POST), 400 = the underlying request lapsed. Other non-2xx (5xx,
      // 429) stay retryable.
      if (response.status === 409) {
        throw new ConsentDecisionError("already_decided");
      }
      if (response.status === 400) {
        throw new ConsentDecisionError("expired");
      }
      if (!response.ok) {
        throw new Error(`consent decision failed: ${response.status}`);
      }
      navigate(await readRedirectTo(response));
    },
  };
}

/**
 * `POST /device/verify { userCode }`. On 200 the server returns the consent screen URL (`/consent?ticket=…`)
 * to advance to. A 401 (not signed in) carries a `login_url` to send the user to sign in first; any other
 * non-2xx (429 rate-limit, 400 invalid/expired code) throws so the form shows its error.
 */
export function makeDeviceActions(deps: ClientDeps = {}): DeviceActions {
  const doFetch = deps.fetch ?? fetch;
  const navigate = deps.navigate ?? browserNavigate;
  return {
    async verifyCode(userCode) {
      const response = await doFetch("/device/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userCode }),
      });
      if (response.status === 401) {
        const body = (await response.json().catch(() => ({}))) as { login_url?: unknown };
        if (typeof body.login_url === "string" && body.login_url) {
          navigate(body.login_url);
          return;
        }
        throw new Error("device verify: not signed in");
      }
      if (!response.ok) {
        throw new Error(`device verify failed: ${response.status}`);
      }
      navigate(await readRedirectTo(response));
    },
  };
}
