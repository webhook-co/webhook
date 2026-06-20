import "server-only";

// The credential read shapes mirror Lane B's display-only DTOs (packages/db: ApiKeyListItem,
// GrantListItem). NEITHER carries key_hash or plaintext — Lane B strips them; `start` is the
// safe redacted prefix. E8 swaps the mock loader below for Lane B's listGrants +
// listApiKeysForGrant + listApiKeys under withTenant(orgId) as webhook_app.

export type GrantStatus = "pending_approval" | "active" | "revoked" | "expired";
export type AuthMethod = "pkce_loopback" | "device_code";

export interface ApiKeyItem {
  readonly id: string;
  readonly name: string;
  /** The redacted key prefix (e.g. "whsec_3f9a…") — safe to display; never the hash or plaintext. */
  readonly start: string;
  readonly scopes: readonly string[];
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
}

export interface DeviceGrant {
  readonly id: string;
  readonly status: GrantStatus;
  readonly authMethod: AuthMethod;
  readonly deviceName: string | null;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
  readonly approvedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly expiresAt: Date | null;
  /** Keys minted under this grant (listApiKeysForGrant) — a grant-revoke cascades to these. */
  readonly keys: readonly ApiKeyItem[];
}

export type CredentialsResult =
  | {
      readonly status: "ok";
      readonly devices: readonly DeviceGrant[];
      readonly keys: readonly ApiKeyItem[];
    }
  | { readonly status: "error" }
  | { readonly status: "denied" };

const d = (iso: string) => new Date(iso);

// E6 mock data. Display-safe by construction — no hash/plaintext exists here to leak.
const MOCK: Extract<CredentialsResult, { status: "ok" }> = {
  status: "ok",
  devices: [
    {
      id: "grant_2aF9",
      status: "active",
      authMethod: "device_code",
      deviceName: "Dana's MacBook Pro",
      createdAt: d("2026-05-21T14:02:00Z"),
      lastUsedAt: d("2026-06-19T09:41:00Z"),
      approvedAt: d("2026-05-21T14:03:00Z"),
      revokedAt: null,
      expiresAt: d("2026-08-19T14:02:00Z"),
      keys: [
        {
          id: "key_8cQ1",
          name: "wbhk cli",
          start: "whk_2aF9…7c1d",
          scopes: ["events:read", "events:replay"],
          createdAt: d("2026-05-21T14:03:00Z"),
          lastUsedAt: d("2026-06-19T09:41:00Z"),
          expiresAt: d("2026-08-19T14:02:00Z"),
          revokedAt: null,
        },
      ],
    },
    {
      id: "grant_7bX2",
      status: "expired",
      authMethod: "pkce_loopback",
      deviceName: "ci-runner",
      createdAt: d("2026-03-02T08:10:00Z"),
      lastUsedAt: d("2026-04-30T22:15:00Z"),
      approvedAt: d("2026-03-02T08:11:00Z"),
      revokedAt: null,
      expiresAt: d("2026-06-01T08:10:00Z"),
      keys: [],
    },
  ],
  keys: [
    {
      id: "key_4dM7",
      name: "Production webhook signer",
      start: "whsec_9b3a…e21f",
      scopes: ["endpoints:read", "events:read"],
      createdAt: d("2026-04-12T11:20:00Z"),
      lastUsedAt: d("2026-06-18T17:05:00Z"),
      expiresAt: null,
      revokedAt: null,
    },
  ],
};

/**
 * Load the org's credentials for the dashboard. E6 returns mock data; E8 reads Lane B's db
 * functions under the live session `orgId`. The caller ({@link verifySession}-gated page)
 * supplies the org. Never returns hash/plaintext.
 */
export async function loadCredentials(_orgId: string): Promise<CredentialsResult> {
  return MOCK;
}
