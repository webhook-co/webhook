"use client";

import { Badge, Banner, Card, CardContent, Checkbox } from "@webhook-co/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { setOrgKeepAction } from "@/server/org-cap-actions";

export interface OrgCapPickerOrg {
  readonly orgId: string;
  readonly slug: string;
  readonly name: string;
  readonly isFree: boolean;
  readonly status: "active" | "suspended";
  readonly keepRequestedAt: Date | null;
  /**
   * Did THIS user mark it? Not "did anyone". The mark lives on the org and is visible to every co-owner, but
   * the reconciler only honours it against its author's own ranking — so rendering a co-owner's mark as a
   * tick would tell you your slot is safe when nothing of the sort is true.
   */
  readonly keepRequestedByMe: boolean;
  readonly graceUntil: Date | null;
}

export interface OrgCapPickerProps {
  readonly orgs: readonly OrgCapPickerOrg[];
  readonly cap: number;
}

/** "Jul 30, 2026" in UTC — matching the cap emails, which name the same deadline. */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function formatDay(at: Date): string {
  return `${MONTHS[at.getUTCMonth()]} ${at.getUTCDate()}, ${at.getUTCFullYear()} (UTC)`;
}

/**
 * The free-org-cap picker (PR2b slice 5): choose which of your free organizations survive the cap.
 *
 * Each checkbox is its own save. That's not laziness — RLS gives the web app no cross-org write (`orgs_update`
 * is `id = current_org_id()`), so N changes are N transactions no matter how the UI is shaped. Pretending
 * otherwise with a batched "Save" button would promise an atomicity that doesn't exist and leave the user
 * guessing which half landed when one failed. Per-row saves make the unit of failure the same as the unit of
 * action.
 *
 * It never says "this org will be suspended". It can't: a co-owned org is overflow if it's overflow for ANY
 * of its owners, and this page can't see another user's orgs. It shows your marks — a statement of intent —
 * and lets the reconciler decide. Copy that claims an outcome the code can't compute is exactly how this
 * lane's emails went wrong twice.
 */
export function OrgCapPicker({ orgs, cap }: OrgCapPickerProps) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  /**
   * ONLY the rows with a toggle in flight — deliberately NOT a mirror of `orgs`.
   *
   * A mirror seeded by `useState` initializes once and never re-runs, so it goes stale the moment
   * `router.refresh()` delivers fresh props — and stale here means a tick claiming "this org is protected"
   * beside a freshly-rendered "scheduled to be suspended" from the same row's props. That is reachable in
   * normal use: the mark is org-level, so a co-owner can change it under you.
   *
   * Deriving from props with a per-row override instead means the truth is always the server's, the rollback
   * on failure is just "drop the override", and there is no second copy to drift.
   */
  const [inFlight, setInFlight] = useState<Record<string, boolean>>({});

  const isMarked = (o: OrgCapPickerOrg) => inFlight[o.orgId] ?? o.keepRequestedByMe;

  const free = orgs.filter((o) => o.isFree);
  const overBy = free.length - cap;
  const markedCount = free.filter(isMarked).length;

  function toggle(orgId: string, next: boolean) {
    setError(null);
    setInFlight((m) => ({ ...m, [orgId]: next }));
    startTransition(async () => {
      // try/catch, not just the ok/error union: `setOrgKeepAction` only wraps its DB write, so verifySession,
      // getTenantDb and isOrgOwner all THROW straight out of the action. Without this the promise rejects,
      // the override is never dropped, no error renders — and the user is left looking at a tick that was
      // never saved, for an org that suspends in 14 days.
      try {
        const res = await setOrgKeepAction(orgId, next);
        if (!res.ok) {
          setError(res.error);
          return;
        }
        router.refresh(); // fresh props become the truth; the override below is dropped either way
      } catch {
        setError("Couldn't save that just now. Try again.");
      } finally {
        setInFlight((m) => {
          const { [orgId]: _dropped, ...rest } = m;
          return rest;
        });
      }
    });
  }

  if (orgs.length === 0) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-sm text-fg-secondary">You don&apos;t own any organizations yet.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {overBy > 0 && (
        <Banner tone="warn">
          You own {free.length} free organizations, which is {overBy} over the limit of {cap}. Tick
          the ones you want to keep — we&apos;ll suspend the rest, oldest kept first among any you
          don&apos;t choose. Upgrading an organization takes it out of the count entirely.
        </Banner>
      )}
      {error && <Banner tone="danger">{error}</Banner>}

      <Card>
        <CardContent className="flex flex-col gap-1 pt-6">
          {orgs.map((org) => {
            // A PAID org is never counted, so a mark on it is inert — show it unticked rather than as a
            // ticked-and-disabled box the owner can't clear (reachable: mark a free org, then upgrade it).
            const marked = org.isFree && isMarked(org);
            return (
              <div
                key={org.orgId}
                className="flex items-center gap-3 rounded-md px-2 py-3 hover:bg-bg-subtle"
              >
                <Checkbox
                  checked={marked}
                  // Only THIS row's own in-flight save disables it. A shared pending flag froze every other
                  // row for the duration, silently swallowing clicks — and each save is its own transaction
                  // anyway, so there is nothing to serialize.
                  disabled={!org.isFree || org.orgId in inFlight}
                  onCheckedChange={(v) => toggle(org.orgId, v === true)}
                  aria-label={`Keep ${org.name}`}
                />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/org/${org.slug}/dashboard`}
                      className="truncate text-sm font-medium text-fg hover:underline"
                    >
                      {org.name}
                    </Link>
                    {!org.isFree && <Badge tone="neutral">Paid</Badge>}
                    {org.status === "suspended" && <Badge tone="danger">Suspended</Badge>}
                  </div>
                  <p className="text-xs text-fg-secondary">
                    {!org.isFree
                      ? "On a paid plan — never counts toward the free limit."
                      : org.status === "suspended"
                        ? "Suspended. Upgrade it, or free up a slot, to restore it."
                        : org.graceUntil !== null
                          ? `Scheduled to be suspended on ${formatDay(org.graceUntil)}.`
                          : "Free plan."}
                  </p>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {overBy > 0 && markedCount > cap && (
        // Not blocked, because it cannot be: the write is one org per transaction, so "at most cap marked" is
        // unenforceable at write time and a second tab can always overshoot. The reconciler re-validates by
        // slicing at cap regardless — so say what actually happens rather than pretending to prevent it.
        <p className="text-xs text-fg-secondary">
          You&apos;ve ticked {markedCount}, which is more than the {cap} we can keep. We&apos;ll
          keep the {cap} oldest of the ones you ticked.
        </p>
      )}
    </div>
  );
}
