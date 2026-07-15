// The frozen auth.↔web contracts for the custom email-change ceremony and the login-methods surface. The web
// dashboard types its service bindings against these; the caller always passes the SERVER-verified userId
// (never client-supplied), and the auth Worker is the authority for every check.

// ── Email change ────────────────────────────────────────────────────────────────────────────────────────

/** Step 1 (start): validate the new address and send a 6-digit OTP to the user's CURRENT email. */
export type StartEmailChangeResult =
  | { ok: true }
  | { ok: false; error: string; reason?: "taken" | "same" | "invalid" | "rate_limited" };

/** Step 2 (commit): verify the OTP, then write the email + revoke sessions + purge verification + notify. */
export type CommitEmailChangeResult =
  | { ok: true; oldEmail: string; newEmail: string }
  | {
      ok: false;
      error: string;
      reason?: "invalid_code" | "expired" | "locked" | "taken" | "no_pending";
    };

/** The AUTH_EMAIL_CHANGE service binding (WorkerEntrypoint `EmailChanger`). */
export interface EmailChangeService {
  /** Begin a change: OTP to the current email. `newEmail` is the user's chosen target address. */
  start(userId: string, newEmail: string): Promise<StartEmailChangeResult>;
  /** Complete a change by presenting the OTP. On success the caller re-mints its session with `newEmail`. */
  commit(userId: string, code: string): Promise<CommitEmailChangeResult>;
}

// ── Login methods (social accounts) ─────────────────────────────────────────────────────────────────────

/** One linked social sign-in (a row in `account`) — NOT an OAuth grant (connected apps are a different thing). */
export interface LoginMethod {
  /** The provider id ("google" | "github"). */
  readonly providerId: string;
  /** The provider's account id — opaque; used to target an unlink. */
  readonly accountId: string;
  /** Unix seconds — when this method was linked. */
  readonly linkedAt: number;
}

export interface LoginMethodsSnapshot {
  readonly methods: readonly LoginMethod[];
  /**
   * Whether magic-link (email) remains as a sign-in path. It has NO `account` row (it's email-based), so the
   * last-method guard must count it: a user with one social + magic-link may unlink the social (they can still
   * receive a magic link), but the last remaining path may never be removed.
   */
  readonly hasMagicLink: boolean;
}

export type UnlinkLoginMethodResult =
  { ok: true } | { ok: false; error: string; reason?: "last_method" | "not_found" };

/** The AUTH_LOGIN_METHODS service binding (WorkerEntrypoint `LoginMethods`). Connect (link a NEW provider) is
 *  a browser OAuth redirect to the issuer, not an RPC — so the service only lists + unlinks. */
export interface LoginMethodsService {
  list(userId: string): Promise<LoginMethodsSnapshot>;
  unlink(userId: string, providerId: string, accountId: string): Promise<UnlinkLoginMethodResult>;
}
