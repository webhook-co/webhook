"use client";

import {
  Badge,
  Banner,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Combobox,
  CopyButton,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Field,
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
} from "@webhook-co/ui";
import * as React from "react";

/** The row-actions affordance. A `…` menu keeps one column of controls instead of a row of buttons that
 *  grows every time an action is added — and it is where a user now expects per-row actions to live. */
const Dots = () => (
  <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className="size-4">
    <circle cx="3.5" cy="8" r="1.25" />
    <circle cx="8" cy="8" r="1.25" />
    <circle cx="12.5" cy="8" r="1.25" />
  </svg>
);

import type { CreateInviteResult, RevokeInviteResult } from "@/server/invite-actions";
import type { LeaveOrgResult } from "@/server/leave-org";
import type { MemberActionResult } from "@/server/member-actions";
import type { TeamResult } from "@/server/team";

type OkTeam = Extract<TeamResult, { status: "ok" }>;
type PendingInvite = OkTeam["invites"][number];
type OrgMember = OkTeam["members"][number];
type MembershipRole = "owner" | "admin" | "member";

/** Privilege rank: 0 = owner (most). Mirrors @webhook-co/shared's roleRank, inlined so this client
 *  component doesn't pull the shared (zod-bearing) module into the browser bundle. The SERVER re-checks
 *  every one of these decisions — what's here only decides which controls to draw. */
const ROLE_ORDER: readonly MembershipRole[] = ["owner", "admin", "member"];
function rank(role: string): number {
  const i = ROLE_ORDER.indexOf(role as MembershipRole);
  return i === -1 ? Number.POSITIVE_INFINITY : i;
}
/** May `actor` act on / grant `target`? At-or-below only — you cannot hand out more than you hold. */
function canGrant(actor: string, target: string): boolean {
  const a = rank(actor);
  const t = rank(target);
  return Number.isFinite(a) && Number.isFinite(t) && t >= a;
}

export interface TeamManagerProps {
  readonly result: TeamResult;
  /** Roles the caller may grant (server-derived). The pickers offer exactly these. */
  readonly grantableRoles: readonly MembershipRole[];
  /** Whether the caller may manage members/invites (owner/admin). The actions re-check regardless. */
  readonly canManage: boolean;
  readonly createInvite: (formData: FormData) => Promise<CreateInviteResult>;
  readonly revokeInvite: (formData: FormData) => Promise<RevokeInviteResult>;
  readonly changeRole: (formData: FormData) => Promise<MemberActionResult>;
  readonly removeMember: (formData: FormData) => Promise<MemberActionResult>;
  /** Leave this org. Redirects on success, so it only ever RETURNS on a refusal. */
  readonly leaveOrg: () => Promise<LeaveOrgResult>;
  /** True when this is the user's own personal org — you can't leave that; you delete the account instead. */
  readonly isPersonalOrg: boolean;
}

function acceptUrl(acceptPath: string): string {
  if (typeof window === "undefined") return acceptPath;
  return `${window.location.origin}${acceptPath}`;
}

function roleLabel(role: string): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

/**
 * An invite's expiry, formatted IDENTICALLY on the server and in the browser.
 *
 * A bare `toLocaleDateString()` is a hydration bug, and this component had one: the server (Node) formatted
 * `21/07/2026` and the browser formatted `21/7/2026`, so React threw away the server HTML and re-rendered the
 * tree on the client. Nothing in the test suite could see it — jsdom does not hydrate — and it only surfaced
 * when the page was opened in a real browser.
 *
 * Pinning BOTH the locale and the time zone is what makes it deterministic: without an explicit locale each
 * environment picks its own, and without an explicit zone the same instant can be a different DAY either side
 * of midnight. `en-GB` + `UTC` gives "21 Jul 2026" everywhere — and spelling the month out sidesteps the
 * DD/MM-vs-MM/DD ambiguity that a numeric date would carry anyway.
 */
function expiryLabel(expiresAt: string | Date): string {
  return new Date(expiresAt).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Turn a member-action refusal into copy that says what actually happened. */
function memberErrorCopy(status: MemberActionResult["status"]): string {
  switch (status) {
    case "last_owner":
      return "This is the last owner. Transfer ownership to someone else first — an org with no owner can't be managed by anyone.";
    case "forbidden":
      return "You don't have permission to do that.";
    case "not_found":
      return "They're no longer a member of this org.";
    default:
      return "That didn't work. Please try again.";
  }
}

export function TeamManager({
  result,
  grantableRoles,
  canManage,
  createInvite,
  revokeInvite,
  changeRole,
  removeMember,
  leaveOrg,
  isPersonalOrg,
}: TeamManagerProps) {
  const ok = result.status === "ok" ? result : null;
  const [members, setMembers] = React.useState<readonly OrgMember[]>(ok?.members ?? []);
  const [invites, setInvites] = React.useState<readonly PendingInvite[]>(ok?.invites ?? []);

  const [inviteOpen, setInviteOpen] = React.useState(false);
  const [email, setEmail] = React.useState("");
  const [inviteRole, setInviteRole] = React.useState<string>(grantableRoles[0] ?? "member");
  const [pending, setPending] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [shareLink, setShareLink] = React.useState<{
    email: string;
    url: string;
    emailed: boolean;
  } | null>(null);

  const [revokingInvite, setRevokingInvite] = React.useState<PendingInvite | null>(null);
  const [removingMember, setRemovingMember] = React.useState<OrgMember | null>(null);
  // A pending role change, held until the user confirms (a demotion revokes their credentials).
  const [roleChange, setRoleChange] = React.useState<{
    member: OrgMember;
    newRole: MembershipRole;
  } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [dialogError, setDialogError] = React.useState<string | null>(null);
  const [leaving, setLeaving] = React.useState(false);
  const [leaveError, setLeaveError] = React.useState<string | null>(null);

  if (!ok) {
    return (
      <Banner tone="danger">
        We couldn&apos;t load your team right now. Refresh the page to try again.
      </Banner>
    );
  }

  const callerRole = ok.role;
  const callerId = ok.userId;

  /** May the caller act on this member? Not on themselves here, and never on someone who outranks them. */
  function actionable(m: OrgMember): boolean {
    return canManage && m.userId !== callerId && canGrant(callerRole, m.role);
  }

  function resetInviteForm() {
    setEmail("");
    setInviteRole(grantableRoles[0] ?? "member");
    setFormError(null);
  }

  async function handleInvite(event: React.FormEvent) {
    event.preventDefault();
    setFormError(null);
    setPending(true);
    try {
      const fd = new FormData();
      fd.set("email", email.trim());
      fd.set("role", inviteRole);
      const res = await createInvite(fd);
      if (res.status !== "ok") {
        setFormError(
          res.status === "invalid"
            ? res.message
            : res.status === "forbidden"
              ? "You don't have permission to invite at that role."
              : "We couldn't create the invite. Please try again.",
        );
        return;
      }
      setInviteOpen(false);
      resetInviteForm();
      setShareLink({
        email: res.invitedEmail,
        url: acceptUrl(res.acceptPath),
        emailed: res.emailed,
      });
    } catch {
      setFormError("We couldn't create the invite. Please try again.");
    } finally {
      setPending(false);
    }
  }

  async function confirmRevokeInvite() {
    if (!revokingInvite) return;
    const target = revokingInvite;
    setBusy(true);
    setDialogError(null);
    try {
      const fd = new FormData();
      fd.set("inviteId", target.id);
      const res = await revokeInvite(fd);
      if (res.status !== "ok") {
        setDialogError("We couldn't revoke the invite. Please try again.");
        return;
      }
      setInvites((prev) => prev.filter((i) => i.id !== target.id));
      setRevokingInvite(null);
    } catch {
      setDialogError("We couldn't revoke the invite. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function confirmRemoveMember() {
    if (!removingMember) return;
    const target = removingMember;
    setBusy(true);
    setDialogError(null);
    try {
      const fd = new FormData();
      fd.set("userId", target.userId);
      const res = await removeMember(fd);
      if (res.status !== "ok") {
        setDialogError(memberErrorCopy(res.status));
        return;
      }
      setMembers((prev) => prev.filter((m) => m.userId !== target.userId));
      setRemovingMember(null);
    } catch {
      setDialogError("That didn't work. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function confirmRoleChange() {
    if (!roleChange) return;
    const { member, newRole } = roleChange;
    setBusy(true);
    setDialogError(null);
    try {
      const fd = new FormData();
      fd.set("userId", member.userId);
      fd.set("role", newRole);
      const res = await changeRole(fd);
      if (res.status !== "ok") {
        setDialogError(memberErrorCopy(res.status));
        return;
      }
      setMembers((prev) =>
        prev.map((m) => (m.userId === member.userId ? { ...m, role: newRole } : m)),
      );
      setRoleChange(null);
    } catch {
      setDialogError("That didn't work. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function confirmLeave() {
    setBusy(true);
    setLeaveError(null);
    try {
      // Success REDIRECTS, so this never returns — anything we get back is a refusal. Deliberately NOT
      // wrapped in a catch: leaveOrgAction returns an error RESULT for real faults, so the only thing it
      // throws is Next's redirect signal, which Next itself must receive. Swallowing (or re-wrapping) that
      // would break the navigation and show a false error on a successful leave.
      const res = await leaveOrg();
      setLeaveError(
        res.status === "last_owner"
          ? "You're the only owner of this organization. Make someone else an owner first, then you can leave."
          : "We couldn't leave the organization. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  const canInvite = email.trim() !== "" && !pending;
  // A demotion (lower privilege = higher rank) kills the member's credentials; a promotion doesn't.
  const isDemotion = roleChange ? rank(roleChange.newRole) > rank(roleChange.member.role) : false;

  /**
   * ONE table, members and invites together — because they are the same question.
   *
   * The page used to be two Cards: "Members" (a <ul>) and "Pending invites" (another <ul>). But nobody comes
   * to this page asking "who are my members?" and separately "what invites are outstanding?" — they ask WHO
   * HAS OR IS GETTING ACCESS, and the answer was split across two lists with different shapes and different
   * controls. An invite is just a member whose status is `Pending`. So it is a row, with a Status column, and
   * the split disappears.
   */
  type Row =
    | { readonly kind: "member"; readonly key: string; readonly member: OrgMember }
    | { readonly kind: "invite"; readonly key: string; readonly invite: PendingInvite };

  const rows: readonly Row[] = [
    ...members.map((m): Row => ({ kind: "member", key: `m:${m.userId}`, member: m })),
    ...invites.map((i): Row => ({ kind: "invite", key: `i:${i.id}`, invite: i })),
  ];

  const roleOptions = grantableRoles.map((r) => ({ value: r, label: roleLabel(r) }));

  return (
    <div className="flex flex-col gap-6">
      {/* The invite button sits in the PAGE HEADER — top-right, outside the content box. It is the one
          affirmative action on this page, and burying it inside the card's header made it look like it acted
          on the card rather than on the org. */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1.5">
          <h1 className="text-2xl font-semibold tracking-heading text-fg">Team</h1>
          <p className="leading-snug text-fg-secondary">
            Everyone with access to this organization, and the invites waiting to be accepted.
          </p>
        </div>

        {canManage ? (
          <Dialog
            open={inviteOpen}
            onOpenChange={(open) => {
              setInviteOpen(open);
              if (!open) resetInviteForm();
            }}
          >
            <DialogTrigger asChild>
              <Button>Invite teammate</Button>
            </DialogTrigger>
            <DialogContent>
              <form onSubmit={handleInvite} className="flex flex-col gap-5">
                <DialogHeader>
                  <DialogTitle>Invite a teammate</DialogTitle>
                  <DialogDescription>
                    They&apos;ll get a link to join. It only works for the email you enter, and
                    expires in 7 days.
                  </DialogDescription>
                </DialogHeader>

                <Field
                  label="Email"
                  type="email"
                  placeholder="teammate@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={pending}
                />

                {/* Our Combobox, not the native <select> this used to be. The native control renders as the
                    OS's own widget — a different typeface, a different focus ring, a different popover on
                    every platform — sitting inside a dialog that is otherwise entirely ours. We already use
                    this Combobox for picking a provider; a role is the same kind of choice. */}
                <Combobox
                  id="invite-role"
                  label="Role"
                  options={roleOptions}
                  value={inviteRole}
                  disabled={pending}
                  onChange={setInviteRole}
                  className="w-full"
                />

                {formError ? <Banner tone="danger">{formError}</Banner> : null}

                <DialogFooter>
                  <DialogClose asChild>
                    <Button type="button" variant="secondary" disabled={pending}>
                      Cancel
                    </Button>
                  </DialogClose>
                  <Button type="submit" loading={pending} disabled={!canInvite}>
                    Send invite
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        ) : null}
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-px text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableEmpty colSpan={5}>Nobody here yet.</TableEmpty>
                </TableRow>
              ) : null}

              {rows.map((row) => {
                if (row.kind === "invite") {
                  const invite = row.invite;
                  return (
                    <TableRow key={row.key}>
                      {/* An invited person has no name yet — they have not accepted, so we have never met
                          them. Saying so is more honest than repeating their email into the Name column. */}
                      <TableCell className="text-fg-muted">—</TableCell>
                      <TableCell className="font-medium text-fg">{invite.invitedEmail}</TableCell>
                      <TableCell>{roleLabel(invite.role)}</TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <span>
                            <Badge tone="warn">Pending</Badge>
                          </span>
                          <span className="text-xs text-fg-muted">
                            Expires {expiryLabel(invite.expiresAt)}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        {canManage ? (
                          <DropdownMenu>
                            <DropdownMenuTrigger
                              aria-label={`Actions for the invite to ${invite.invitedEmail}`}
                              className="inline-grid size-8 place-items-center rounded-control text-fg-secondary outline-none transition-colors hover:bg-surface-sunken hover:text-fg focus-visible:shadow-[var(--wh-focus-ring)]"
                            >
                              <Dots />
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                destructive
                                onSelect={() => {
                                  setDialogError(null);
                                  setRevokingInvite(invite);
                                }}
                              >
                                Revoke invite
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  );
                }

                const m = row.member;
                const isYou = m.userId === callerId;
                const canAct = actionable(m);
                // Only the roles you may grant, and never the one they already hold — an item that changes
                // nothing is not an action.
                const otherRoles = grantableRoles.filter((r) => r !== m.role);

                return (
                  <TableRow key={row.key}>
                    <TableCell className="font-medium text-fg">
                      <span className="flex items-center gap-2">
                        <span className="truncate">{m.name || "—"}</span>
                        {isYou ? <Badge tone="neutral">You</Badge> : null}
                      </span>
                    </TableCell>
                    <TableCell>{m.email}</TableCell>
                    <TableCell>{roleLabel(m.role)}</TableCell>
                    <TableCell>
                      <Badge tone="ok">Active</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {canAct ? (
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            aria-label={`Actions for ${m.name || m.email}`}
                            className="inline-grid size-8 place-items-center rounded-control text-fg-secondary outline-none transition-colors hover:bg-surface-sunken hover:text-fg focus-visible:shadow-[var(--wh-focus-ring)]"
                          >
                            <Dots />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {otherRoles.map((r) => (
                              <DropdownMenuItem
                                key={r}
                                onSelect={() => {
                                  setDialogError(null);
                                  setRoleChange({ member: m, newRole: r });
                                }}
                              >
                                Make {roleLabel(r).toLowerCase()}
                              </DropdownMenuItem>
                            ))}
                            {otherRoles.length > 0 ? <DropdownMenuSeparator /> : null}
                            <DropdownMenuItem
                              destructive
                              onSelect={() => {
                                setDialogError(null);
                                setRemovingMember(m);
                              }}
                            >
                              Remove from organization
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Leaving is only offered where it's meaningful: you can't leave your own personal org (delete the
          account instead), and a sole owner is refused by the server anyway — but we say so up front rather
          than letting them click into a wall. */}
      {!isPersonalOrg ? (
        <Card>
          <CardHeader>
            <CardTitle>Leave this organization</CardTitle>
            <CardDescription>
              You&apos;ll lose access immediately, and the API keys and devices you created for this
              organization are revoked. You can rejoin only if someone invites you again.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {leaveError ? <Banner tone="danger">{leaveError}</Banner> : null}
            <div>
              <Button variant="danger" onClick={() => setLeaving(true)} disabled={busy}>
                Leave organization
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Dialog
        open={leaving}
        onOpenChange={(open) => {
          if (open || busy) return;
          setLeaving(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Leave this organization?</DialogTitle>
            <DialogDescription>
              You lose access immediately, and the API keys and devices you created here stop
              working. This can&apos;t be undone — you&apos;d need a new invite to come back.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="secondary" disabled={busy}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              variant="danger"
              disabled={busy}
              onClick={async () => {
                await confirmLeave();
                setLeaving(false);
              }}
            >
              Leave organization
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remove member — state the consequence, don't imply it */}
      <Dialog
        open={removingMember !== null}
        onOpenChange={(open) => {
          if (open || busy) return;
          setRemovingMember(null);
          setDialogError(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove from this organization?</DialogTitle>
            <DialogDescription>
              {removingMember
                ? `${removingMember.name || removingMember.email} loses access immediately. Their API keys and connected devices for this org are revoked and can't be restored.`
                : null}
            </DialogDescription>
          </DialogHeader>
          {dialogError ? <Banner tone="danger">{dialogError}</Banner> : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="secondary" disabled={busy}>
                Cancel
              </Button>
            </DialogClose>
            <Button variant="danger" onClick={confirmRemoveMember} disabled={busy}>
              Remove member
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Role change — a demotion revokes credentials, so say so before it happens */}
      <Dialog
        open={roleChange !== null}
        onOpenChange={(open) => {
          if (open || busy) return;
          setRoleChange(null);
          setDialogError(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change role?</DialogTitle>
            <DialogDescription>
              {roleChange
                ? isDemotion
                  ? `${roleChange.member.name || roleChange.member.email} becomes a ${roleLabel(roleChange.newRole).toLowerCase()}. Because that's less access than they have now, the API keys they created are revoked — a key can't keep powers its owner no longer has.`
                  : `${roleChange.member.name || roleChange.member.email} becomes a ${roleLabel(roleChange.newRole).toLowerCase()}. Their existing API keys keep working.`
                : null}
            </DialogDescription>
          </DialogHeader>
          {dialogError ? <Banner tone="danger">{dialogError}</Banner> : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="secondary" disabled={busy}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              variant={isDemotion ? "danger" : "primary"}
              onClick={confirmRoleChange}
              disabled={busy}
            >
              Change role
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Revoke invite */}
      <Dialog
        open={revokingInvite !== null}
        onOpenChange={(open) => {
          if (open || busy) return;
          setRevokingInvite(null);
          setDialogError(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke invite?</DialogTitle>
            <DialogDescription>
              {revokingInvite
                ? `The link sent to "${revokingInvite.invitedEmail}" will stop working. This can't be undone.`
                : null}
            </DialogDescription>
          </DialogHeader>
          {dialogError ? <Banner tone="danger">{dialogError}</Banner> : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="secondary" disabled={busy}>
                Cancel
              </Button>
            </DialogClose>
            <Button variant="danger" onClick={confirmRevokeInvite} disabled={busy}>
              Revoke invite
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Share-link reveal after a successful invite */}
      <Dialog open={shareLink !== null} onOpenChange={(open) => !open && setShareLink(null)}>
        <DialogContent hideCloseButton>
          <DialogHeader>
            <DialogTitle>
              {shareLink?.emailed ? "Invite sent" : "Share the invite link"}
            </DialogTitle>
            <DialogDescription>
              {shareLink
                ? shareLink.emailed
                  ? `We emailed the invite to ${shareLink.email}.`
                  : `Send this link to ${shareLink.email} so they can join.`
                : null}
            </DialogDescription>
          </DialogHeader>
          {/* Say only what actually happened: if the email didn't go out, don't imply it did. */}
          <Banner tone="info">
            {shareLink?.emailed
              ? "You can also share this link directly — it isn't shown again here."
              : "We couldn't email it, so copy the link now — it isn't shown again here."}
          </Banner>
          {shareLink ? (
            <div className="flex items-center gap-2 rounded-control border border-hairline bg-surface-sunken p-3">
              <code className="min-w-0 flex-1 truncate font-mono text-sm text-fg">
                {shareLink.url}
              </code>
              <CopyButton value={shareLink.url} size="sm" />
            </div>
          ) : null}
          <DialogFooter>
            <Button onClick={() => setShareLink(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
