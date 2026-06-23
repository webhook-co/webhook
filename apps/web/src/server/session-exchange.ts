import "server-only";

import { getAuthBaseUrl, getSessionExchangeBinding } from "./env";
import type { Session } from "./session";

/** The principal payload auth. returns — over the service binding (RPC) or the public HTTP route (fetch). */
interface ExchangePrincipal {
  orgId?: unknown;
  userId?: unknown;
  name?: unknown;
  email?: unknown;
  image?: unknown;
}

/** auth.'s SessionExchange WorkerEntrypoint, reachable over a Cloudflare service binding. */
export interface SessionExchangeBinding {
  /** Redeem a single-use handoff ticket → the principal, or `null` for an invalid/expired/used ticket. */
  exchange(ticket: string): Promise<ExchangePrincipal | null>;
}

/** Validate + map a principal payload to a Session, or throw (invalid → the caller redirects to login). */
function toSession(data: ExchangePrincipal): Session {
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

/**
 * Redeem an A-SX handoff ticket for the session principal { orgId, userId, name, email, image } (ADR-0033).
 * The ticket is the single-use, audience-bound credential — auth. atomically burns it, reads the user's
 * profile fresh, and returns the principal. This is the **one** auth. backchannel on the v1 path; after it,
 * app. holds its own signed session and never calls back.
 *
 * Transport: PREFER the `AUTH_SESSION_EXCHANGE` Cloudflare service binding (a direct WorkerEntrypoint RPC, no
 * public hop) when it's bound; otherwise fall back to a `POST ${authBase}/session/exchange`. The fetch path
 * keeps dev + preview working AND survives any deploy-ordering gap (auth.'s SessionExchange entrypoint must be
 * live before web's binding resolves — until then the binding is simply unbound and we fetch). A `null`
 * binding result, a non-2xx fetch (invalid/expired/replayed/wrong-audience all collapse to 401), or a
 * malformed principal throws — the caller (the /auth/callback route) redirects to login.
 *
 * `fetch` / `authBaseUrl` / `binding` are injectable for tests; in prod they default to the global fetch, the
 * auth. host, and the bound `AUTH_SESSION_EXCHANGE` entrypoint (undefined when unbound — dev/pre-provision).
 */
export async function exchangeTicket(
  ticket: string,
  deps: {
    fetch?: typeof fetch;
    authBaseUrl?: string;
    binding?: SessionExchangeBinding;
  } = {},
): Promise<Session> {
  const binding = deps.binding ?? getSessionExchangeBinding();
  if (binding) {
    // Wrap ONLY the RPC call so we can tell a binding/transport FAULT (the RPC throws) from an auth
    // DECISION (the RPC responds with `null` or a principal). A thrown error means the
    // OpenNext→WorkerEntrypoint RPC itself failed — degrade to the proven public fetch path below
    // rather than break login (the route stays live until it's retired). Once the RPC has responded
    // it is authoritative: a `null` verdict (invalid/expired/used/wrong-audience) throws, and a
    // malformed principal throws in toSession — neither falls back. The fault warns (no PII) so a
    // silently-broken RPC stays visible in logs (and the public route can't be retired until it's gone).
    let principal: ExchangePrincipal | null = null;
    let rpcFaulted = false;
    try {
      principal = await binding.exchange(ticket);
    } catch {
      console.warn(
        JSON.stringify({ msg: "session_exchange.binding_rpc_failed", fallback: "public_fetch" }),
      );
      rpcFaulted = true;
    }
    if (!rpcFaulted) {
      if (!principal) {
        throw new Error("session exchange failed: ticket invalid or expired");
      }
      return toSession(principal);
    }
  }

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

  return toSession((await response.json()) as ExchangePrincipal);
}
