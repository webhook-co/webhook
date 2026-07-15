// The human-facing scope catalog: a plain-English title + description for each OAuth/API scope, so review
// surfaces (connected apps, API keys, devices) and the consent screen can speak to people instead of showing
// raw `resource:verb` strings. The scope NAMES are owned by `capability.ts` (the closed SoT); this file only
// adds display copy for them — a typo'd key here is dead copy, not a broken grant.
//
// Kept in @webhook-co/contract because both apps/web (dashboard review surfaces) and apps/auth (consent) need
// the same words, and drift between "what the consent screen said" and "what the dashboard shows" is exactly
// the kind of trust gap this catalog exists to close.

export type ScopeCategory = "read" | "manage" | "destructive" | "identity";

export interface ScopeInfo {
  /** The raw scope string, echoed back verbatim. */
  readonly scope: string;
  /** A short human title, sentence-case (e.g. "View events"). */
  readonly title: string;
  /** One plain sentence on what granting it allows. */
  readonly description: string;
  readonly category: ScopeCategory;
}

const CATALOG: Record<string, Omit<ScopeInfo, "scope">> = {
  "endpoints:read": {
    title: "View endpoints",
    description: "See your webhook endpoints and their configuration.",
    category: "read",
  },
  "endpoints:write": {
    title: "Manage endpoints",
    description: "Create, edit, and delete webhook endpoints.",
    category: "manage",
  },
  "events:read": {
    title: "View events",
    description: "Read captured webhook events and their payloads.",
    category: "read",
  },
  "events:replay": {
    title: "Replay events",
    description: "Re-deliver captured events to their destinations.",
    category: "manage",
  },
  "events:delete": {
    title: "Delete events",
    description: "Permanently redact and purge captured event payloads.",
    category: "destructive",
  },
  "audit:read": {
    title: "View audit log",
    description: "Read the tamper-evident audit history.",
    category: "read",
  },
  "triggers:write": {
    title: "Manage triggers",
    description: "Create and revoke webhook-to-agent trigger subscriptions.",
    category: "manage",
  },
  "billing:read": {
    title: "View billing",
    description: "See your plan, usage, and invoices.",
    category: "read",
  },
  "keys:manage": {
    title: "Manage credentials",
    description: "Create and revoke API keys and device grants.",
    category: "manage",
  },
  profile: {
    title: "Your identity",
    description: "Shares your name and email with this app.",
    category: "identity",
  },
  // Standard OIDC scopes that can ride along on a grant — described so they're never a bare mystery string.
  openid: {
    title: "Sign you in",
    description: "Confirms your webhook.co identity to this app.",
    category: "identity",
  },
  email: {
    title: "Your email",
    description: "Shares your email address with this app.",
    category: "identity",
  },
  offline_access: {
    title: "Stay connected",
    description: "Keeps access while you're away by refreshing its token.",
    category: "identity",
  },
};

/**
 * Describe a scope for display. Unknown scopes (a newer server, a forward-compat grant) fall back to the raw
 * name as the title with a truthful generic description — we NEVER silently drop a scope or claim it does
 * nothing, because a hidden permission on a review surface is the exact trust failure this catalog prevents.
 */
export function describeScope(scope: string): ScopeInfo {
  const entry = CATALOG[scope];
  if (entry) return { scope, ...entry };
  return {
    scope,
    title: scope,
    description: `Grants the “${scope}” permission.`,
    category: "manage",
  };
}
