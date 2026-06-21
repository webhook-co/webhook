import "server-only";

import { getAuthBaseUrl } from "./env";
import type { Session } from "./session";

/**
 * Redeem an A-SX handoff ticket against auth.'s `POST /session/exchange` (ADR-0033). The ticket is the
 * single-use, audience-bound credential — auth. atomically burns it, reads the user's profile fresh, and
 * returns `{ orgId, userId, name, email, image }`. This is the **one** auth. backchannel on the v1 path;
 * after it, app. holds its own signed session and never calls back. A non-2xx (invalid/expired/replayed/
 * wrong-audience all collapse to 401) or a malformed principal throws — the caller redirects to login.
 *
 * `fetch`/`authBaseUrl` are injectable for tests; in prod they default to the global fetch + auth. host.
 * (The deploy slice adds an app.↔auth. shared-secret header here for defense-in-depth — ADR-0033.)
 */
export async function exchangeTicket(
  ticket: string,
  deps: { fetch?: typeof fetch; authBaseUrl?: string } = {},
): Promise<Session> {
  const fetchImpl = deps.fetch ?? fetch;
  const base = deps.authBaseUrl ?? getAuthBaseUrl();

  const response = await fetchImpl(`${base}/session/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ticket }),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`session exchange failed: ${response.status}`);
  }

  const data = (await response.json()) as {
    orgId?: unknown;
    userId?: unknown;
    name?: unknown;
    email?: unknown;
    image?: unknown;
  };

  if (
    typeof data.orgId !== "string" ||
    !data.orgId ||
    typeof data.userId !== "string" ||
    !data.userId
  ) {
    throw new Error("session exchange returned an invalid principal");
  }

  return {
    userId: data.userId,
    orgId: data.orgId,
    user: {
      name: typeof data.name === "string" ? data.name : "",
      email: typeof data.email === "string" ? data.email : "",
      image: typeof data.image === "string" ? data.image : null,
    },
  };
}
