// The frozen auth.↔web "connected apps" contract. A user's active OAuth grants (the third-party MCP clients
// they authorized — Claude, Cursor, …) live in the auth. Worker's OAUTH_KV grant store, which the web
// dashboard can't read locally. auth. exposes them over a service-binding entrypoint (ConnectedApps), and
// the dashboard lists + revokes them against THIS one definition.
//
// NOTE: these grants are the PROVIDER's opaque-token grants (the /oauth/token flow), distinct from the
// whk_-key "devices" in auth_grant (the CLI/frozen-/token flow shown on the credentials page). This is the
// surface for the OAuth apps a user connected an MCP client with.

/** One connected app = one active OAuth grant, projected for display + revoke. */
export interface ConnectedApp {
  /** The provider grant id — passed back to revoke this app's access. */
  grantId: string;
  /** The OAuth client id. For a CIMD client this is the https metadata-doc URL; for DCR, an opaque id. */
  clientId: string;
  /** The client's display name — already sanitized (bidi/control stripped); never trusted as identity. */
  clientName: string;
  /** The un-spoofable proven-controlled domain (a CIMD host), or null for an opaque DCR client. */
  identityDomain: string | null;
  /** Whether the client is on the curated vetted list (a "verified" indicator). */
  verified: boolean;
  /** The scopes this app was granted. */
  scopes: string[];
  /** Unix seconds — when the grant was authorized. */
  createdAt: number;
  /** Unix seconds — when the grant expires, if a TTL is set. */
  expiresAt?: number;
}

/**
 * The connected-apps RPC seam — a Cloudflare service-binding entrypoint on auth. (ConnectedApps). The web
 * dashboard types its `env.<binding>` against this so the cross-Worker call site is contract-checked. The
 * caller passes the SERVER-authenticated userId (from its own session — never client-supplied), so a user
 * can only ever list/revoke their OWN grants.
 */
export interface ConnectedAppsService {
  /** List a user's active connected apps (their authorized OAuth clients). */
  listConnectedApps(userId: string): Promise<ConnectedApp[]>;
  /** Revoke one connected app by grant id. Idempotent — always resolves true (the provider's revoke is a
   *  void no-op on a grantId the user doesn't own, so there is no "was it there" signal). */
  revokeConnectedApp(userId: string, grantId: string): Promise<boolean>;
}
