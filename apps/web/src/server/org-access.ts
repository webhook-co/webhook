import "server-only";

import { listUserOrgs, type MembershipRole } from "@webhook-co/db/orgs";
import { notFound, permanentRedirect } from "next/navigation";
import { cache } from "react";

import { withTenantDb } from "./db";
import { verifySession, type Session } from "./session";

// The org-access gate: the ONE place a request proves which org it is acting in, that the caller may act
// there, and what they may do.
//
// ── The org comes from the URL now, and the URL is client input ──────────────────────────────────────────
//
// It used to come from the session cookie. That became a live correctness bug the moment the org switcher
// shipped, because there is ONE cookie per browser: tab A open on Alpha, switch to Beta in tab B, click
// "create endpoint" back in tab A — and the action read the cookie, saw Beta, and created the endpoint in the
// WRONG ORG. Silently. RLS does not save you: the user IS a member of Beta, so the write is authorized, just
// aimed at the wrong place. The same held for minting an API key, sending an invite, changing a role.
//
// Putting the org in the URL makes that unrepresentable: the org a page renders and the org its actions
// mutate are the same string, and it is right there in the address bar.
//
// ── Why a URL segment is safe, and where the safety actually lives ───────────────────────────────────────
//
// A slug in the path is untrusted input, exactly like a hidden form field. What makes it safe is not that we
// validate it, but WHERE we resolve it.
//
// A *global* slug -> orgId lookup is STRUCTURALLY IMPOSSIBLE for webhook_app: its only SELECT policy on
// `orgs` is `id = current_org_id()`, so `select id from orgs where slug = $1` returns zero rows — silently,
// which is the dangerous kind of wrong. And the obvious fix — a permissive policy so any slug can be looked
// up — is precisely the privilege escalation ADR-0113 exists to prevent, because Postgres policies are
// PERMISSIVE and OR together.
//
// So the slug is resolved INSIDE THE CALLER'S OWN DIRECTORY (`user_org_directory()`, bounded by
// `current_app_user()`). Two consequences follow, and they are the whole design:
//
//   * **Resolution and the membership check are THE SAME OPERATION.** They cannot drift apart, because there
//     is only one of them. There is no path on which a slug resolves but membership goes unchecked.
//   * **There is no enumeration oracle — by construction, not by a check someone must remember.** A slug you
//     don't belong to is indistinguishable from one nobody ever registered: the resolver never sees either.
//     That is why a miss is `notFound()`, never `403`.
//
// The session cookie still carries an `orgId`, but it is now only a DEFAULT-ORG HINT, read in exactly one
// place (`/`, the post-login landing) to decide where to send you. Nothing authoritative reads it.

export interface OrgAccess extends Session {
  /** The org resolved FROM THE URL — not from the cookie. This is the org the request acts in. */
  readonly orgId: string;
  /** Its CURRENT slug, canonically cased. Use this for links and `revalidatePath`, never the raw URL segment. */
  readonly slug: string;
  /** Its display name, from the SAME directory read that proved membership — the authoritative value, never
   * inferred from the slug. A settings page renders this directly instead of re-querying. */
  readonly name: string;
  /** The caller's role in `orgId`, read this request. Never null — a non-member never gets here. */
  readonly role: MembershipRole;
}

/** citext matches case-insensitively; JS `===` does not. Compare the way the database does. */
const sameSlug = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * The pure resolution + membership check, memoized ON THE SLUG ALONE.
 *
 * Keeping the cache key to just `slug` is what lets the layout (`requireOrgAccess(slug)`) and every page
 * (which also needs to canonicalize) share ONE `user_org_directory()` round-trip per request. An earlier
 * version memoized the two-arg entry point, so the layout's `(slug)` and a page's `(slug, subPath)` were
 * distinct cache entries and the directory was queried twice on every navigation. The redirect decision is
 * pure and cheap, so it lives OUTSIDE the memo — see `requireOrgAccess`.
 */
const resolveOrgAccess = cache(async (slug: string): Promise<OrgAccess> => {
  const session = await verifySession();
  const orgs = await withTenantDb((app) => listUserOrgs(app, session.userId));

  const current = orgs.find((o) => sameSlug(o.slug, slug));
  if (current) {
    return {
      ...session,
      orgId: current.orgId,
      slug: current.slug,
      name: current.name,
      role: current.role,
    };
  }

  // A slug this org has been renamed AWAY from. Old links must keep working — that is the entire point of
  // keeping the history.
  const renamed = orgs.find((o) => o.formerSlugs.some((f) => sameSlug(f, slug)));
  if (renamed) {
    return {
      ...session,
      orgId: renamed.orgId,
      slug: renamed.slug,
      name: renamed.name,
      role: renamed.role,
    };
  }

  // Not in this caller's directory. It could be another org's slug, or nothing at all — and we cannot tell,
  // which is exactly the property we want. 404, never 403.
  notFound();
});

export const requireOrgAccess = async (slug: string, subPath?: string): Promise<OrgAccess> => {
  const access = await resolveOrgAccess(slug);

  // Canonicalize AFTER resolving. `access.slug` is the current, correctly-cased spelling; if the URL segment
  // differs (a mis-case, or a retired slug), 308 the browser to the one true URL with the deep path intact.
  //
  // `subPath` carries its own query string when the caller has one (the events page passes
  // `?${searchParams}`), because a bare path would DROP the filters and cursor on a shared/bookmarked link —
  // exactly the "old links keep working" case the former-slug history exists to preserve. Actions omit
  // subPath entirely and so never redirect.
  if (subPath !== undefined && access.slug !== slug) {
    permanentRedirect(`/org/${access.slug}${subPath}`);
  }
  return access;
};
