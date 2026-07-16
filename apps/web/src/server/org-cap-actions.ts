"use server";

import { isOrgOwner, setOrgFreeCapKeep } from "@webhook-co/db/org-lifecycle";
import { revalidatePath } from "next/cache";

import { getTenantDb } from "@/server/db";
import { verifySession } from "@/server/session";

/**
 * The free-org-cap picker's write (PR2b slice 5): mark or unmark ONE org to be kept through the cap.
 *
 * dal-gate-allow: user-scoped — gates on verifySession + an explicit per-org ownership check. There is no
 * `requireOrgAccess` here because the surface is not org-scoped: the cap is a property of the USER, and the
 * picker spans every org they own. The URL carries no slug, so there is no org to gate on.
 *
 * OWNERSHIP IS CHECKED HERE, EXPLICITLY. `setOrgFreeCapKeep` runs under the target org's tenant context, and
 * RLS scopes that write to that org — but scoping is not authorization. Nothing in RLS stops a caller naming
 * an org id they have no business touching; it only stops them touching a DIFFERENT one at the same time. So
 * the ownership proof is this action's job, and `isOrgOwner` (not mere membership) is the bar: the cap is
 * counted against owners, so only an owner's intent about their own slots is meaningful.
 *
 * OWNING THE ORG IS NOT ENOUGH — the mark is also ATTRIBUTED to `session.userId`, and that is a second,
 * separate security property. An org can have several owners, but the cap is counted PER owner and the mark
 * is a column on the ORG. So an unattributed mark speaks for every co-owner's slots at once: a co-owner of
 * your throwaway org (whom `isOrgOwner` correctly lets mark it) could re-rank YOUR list and push a different
 * org of yours — one they aren't a member of and can't see — into your overflow to be suspended, while their
 * own list stayed untouched. Recording who asked is what confines a mark's effect to its author's ranking.
 */
export async function setOrgKeepAction(
  orgId: string,
  keep: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await verifySession();
  const app = await getTenantDb();

  if (!(await isOrgOwner(app, session.userId, orgId))) {
    // Deliberately the same message whether the org doesn't exist or isn't theirs — a distinct "no such org"
    // would turn this into an org-id existence oracle for any signed-in user.
    return { ok: false, error: "You can only change organizations you own." };
  }

  try {
    await setOrgFreeCapKeep(app, orgId, session.userId, keep);
  } catch (err) {
    console.log(JSON.stringify({ message: "org_cap.keep_failed", error: String(err) }));
    return { ok: false, error: "Couldn't save that just now. Try again." };
  }

  revalidatePath("/account/organizations");
  return { ok: true };
}
