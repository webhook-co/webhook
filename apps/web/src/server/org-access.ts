import "server-only";

import { withTenant } from "@webhook-co/db/client";
import { readMembershipRole, type MembershipRole } from "@webhook-co/db/orgs";
import { redirect } from "next/navigation";
import { cache } from "react";

import { withTenantDb } from "./db";
import { LOGIN_URL, verifySession, type Session } from "./session";

// The org-access gate: the ONE place a request proves the caller may act in the session's org, and learns
// their role.
//
// `verifySession()` proves IDENTITY and yields the session's orgId. It does not prove membership, and RLS
// does not either — RLS only proves a query was scoped to the org the query named. Nothing in that chain
// re-asks whether the caller still belongs to it.
//
// That distinction is the whole point, because the session is STATELESS: a signed cookie with a 7-day TTL
// and NO server-side revocation store. The org it names is a claim made at mint time, and it goes on being
// made long after it stops being true. Re-reading membership per request is the only thing that can make it
// honest again.
//
// This was applied to the server ACTIONS and — until the e2e suite caught it — never to the pages. Every
// gated page and the (app) render gate called `verifySession()` alone, so the entire READ surface trusted
// the cookie's orgId outright: a removed member's live cookie kept rendering the org's endpoints, events,
// deliveries and webhook payloads until it expired, while their writes were correctly refused. The claims in
// ADR-0113 ("re-checks membership on EVERY request … even a mis-minted cookie could not be used") and
// ADR-0115 ("web access dies on the next request") were true of actions and false of renders.
//
// So the gate is no longer optional for a page. `dal-gate-guard.mjs` now requires *this* function — not
// merely `verifySession` — everywhere under `(app)/`.

export interface OrgAccess extends Session {
  /** The caller's role in `orgId`, read under RLS this request. Never null — a null membership fails closed. */
  readonly role: MembershipRole;
}

/**
 * Verify the caller's session AND that they are currently a member of the session's org; return the session
 * plus their role. Fails closed: no cookie → redirect to sign-in (via verifySession); a valid cookie whose
 * org the user is no longer a member of → also redirect to sign-in (a removed member is no longer a valid
 * principal, and a stale session must not keep acting). The membership read names org_id explicitly and runs
 * under that org's RLS context (RLS policies are permissive/OR'd — never lean on RLS alone; see
 * readMembershipRole).
 *
 * Wrapped in React's `cache`, so the layout and the page it renders — which run CONCURRENTLY, and must
 * therefore BOTH gate; a layout's redirect does not stop a page's query from having already executed — share
 * one membership read per request instead of issuing one each.
 */
export const requireOrgAccess = cache(async (): Promise<OrgAccess> => {
  const session = await verifySession();
  const role = await withTenantDb((app) =>
    withTenant(app, session.orgId, (tx) => readMembershipRole(tx, session.orgId, session.userId)),
  );
  if (role === null) {
    // The signed session names an org this user is no longer a member of. Treat exactly like an expired
    // session — send them back through auth., which re-mints a session for an org they DO belong to. This
    // assumes auth. never re-mints for the same left org; once multi-org "current org" selection lands
    // (the auth-issuer lane) that must hold, or a removed member could bounce login↔here. Worst case is a
    // redirect loop (availability), never access — the gate has already refused to return.
    redirect(LOGIN_URL);
  }
  return { ...session, role: role as MembershipRole };
});
