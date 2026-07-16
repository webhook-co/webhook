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
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  /** Optimistic marks, keyed by org id — the checkbox must respond before the round-trip. */
  const [marks, setMarks] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(orgs.map((o) => [o.orgId, o.keepRequestedAt !== null])),
  );

  const free = orgs.filter((o) => o.isFree);
  const overBy = free.length - cap;
  const markedCount = free.filter((o) => marks[o.orgId]).length;

  function toggle(orgId: string, next: boolean) {
    setError(null);
    setMarks((m) => ({ ...m, [orgId]: next }));
    startTransition(async () => {
      const res = await setOrgKeepAction(orgId, next);
      if (!res.ok) {
        setMarks((m) => ({ ...m, [orgId]: !next })); // roll the optimistic flip back
        setError(res.error);
        return;
      }
      router.refresh();
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
            const marked = marks[org.orgId] ?? false;
            return (
              <div
                key={org.orgId}
                className="flex items-center gap-3 rounded-md px-2 py-3 hover:bg-bg-subtle"
              >
                <Checkbox
                  checked={marked}
                  disabled={!org.isFree || pending}
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
