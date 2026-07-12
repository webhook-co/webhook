import "server-only";

import { withTenant } from "@webhook-co/db/client";
import { readMembershipRole, type MembershipRole } from "@webhook-co/db/orgs";
import { redirect } from "next/navigation";

import { withTenantDb } from "./db";
import { LOGIN_URL, verifySession, type Session } from "./session";

// The org-access gate (Lane 2.2): the ONE place a server action proves the caller may act in the session's
// org and learns their role. verifySession() proves identity and yields the session's orgId, but RLS only
// proves a query is scoped to that org — never that the caller is (still) a member or what they may do. This
// closes that gap at the front door: it re-reads membership PER REQUEST, so a removed member (or a stale
// 7-day cookie naming an org they've left) is turned away like an expired session, not left to slip past to
// the per-mutation checks. It returns the role so role-gated actions have a single source instead of each
// re-reading it. It is strictly stronger than verifySession (it calls it, then adds membership), so the
// dal-gate-guard accepts either. Actions migrate to it incrementally.

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
 */
export async function requireOrgAccess(): Promise<OrgAccess> {
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
}
