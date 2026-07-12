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
  CopyButton,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Field,
  Label,
  Select,
} from "@webhook-co/ui";
import * as React from "react";

import type { CreateInviteResult, RevokeInviteResult } from "@/server/invite-actions";
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
}

function acceptUrl(acceptPath: string): string {
  if (typeof window === "undefined") return acceptPath;
  return `${window.location.origin}${acceptPath}`;
}

function roleLabel(role: string): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
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

  const canInvite = email.trim() !== "" && !pending;
  // A demotion (lower privilege = higher rank) kills the member's credentials; a promotion doesn't.
  const isDemotion = roleChange ? rank(roleChange.newRole) > rank(roleChange.member.role) : false;

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div className="flex flex-col gap-1.5">
              <CardTitle>Members</CardTitle>
              <CardDescription>
                Everyone with access to this organization. Owners and admins can invite people and
                manage roles.
              </CardDescription>
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

                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="invite-role">Role</Label>
                      <Select
                        id="invite-role"
                        value={inviteRole}
                        disabled={pending}
                        onChange={(e) => setInviteRole(e.target.value)}
                      >
                        {grantableRoles.map((r) => (
                          <option key={r} value={r}>
                            {roleLabel(r)}
                          </option>
                        ))}
                      </Select>
                    </div>

                    {formError ? <Banner tone="danger">{formError}</Banner> : null}

                    <DialogFooter>
                      <DialogClose asChild>
                        <Button type="button" variant="secondary">
                          Cancel
                        </Button>
                      </DialogClose>
                      <Button type="submit" disabled={!canInvite}>
                        Send invite
                      </Button>
                    </DialogFooter>
                  </form>
                </DialogContent>
              </Dialog>
            ) : null}
          </div>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col divide-y divide-hairline">
            {members.map((m) => {
              const isYou = m.userId === callerId;
              const canAct = actionable(m);
              const selectId = `role-${m.userId}`;
              return (
                <li key={m.userId} className="flex items-center justify-between gap-4 py-3">
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate font-medium text-fg">{m.name || m.email}</span>
                      {isYou ? <Badge tone="neutral">You</Badge> : null}
                    </span>
                    <span className="truncate text-xs text-fg-secondary">{m.email}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    {canAct ? (
                      <>
                        <Label htmlFor={selectId} className="sr-only">
                          Role for {m.email}
                        </Label>
                        <Select
                          id={selectId}
                          value={m.role}
                          onChange={(e) =>
                            setRoleChange({
                              member: m,
                              newRole: e.target.value as MembershipRole,
                            })
                          }
                        >
                          {grantableRoles.map((r) => (
                            <option key={r} value={r}>
                              {roleLabel(r)}
                            </option>
                          ))}
                        </Select>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => {
                            setDialogError(null);
                            setRemovingMember(m);
                          }}
                        >
                          Remove
                        </Button>
                      </>
                    ) : (
                      <Badge tone="neutral">{roleLabel(m.role)}</Badge>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Pending invites</CardTitle>
          <CardDescription>
            Invites that haven&apos;t been accepted yet. They expire 7 days after they&apos;re sent.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {invites.length === 0 ? (
            <p className="text-sm text-fg-secondary">No pending invites.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-hairline">
              {invites.map((invite) => (
                <li key={invite.id} className="flex items-center justify-between gap-4 py-3">
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="truncate font-medium text-fg">{invite.invitedEmail}</span>
                    <span className="text-xs text-fg-secondary">
                      Expires {new Date(invite.expiresAt).toLocaleDateString()}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <Badge tone="neutral">{roleLabel(invite.role)}</Badge>
                    {canManage ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                          setDialogError(null);
                          setRevokingInvite(invite);
                        }}
                      >
                        Revoke
                      </Button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

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
