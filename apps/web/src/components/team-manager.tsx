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
import type { TeamResult } from "@/server/team";

type PendingInvite = Extract<TeamResult, { status: "ok" }>["invites"][number];
type MembershipRole = "owner" | "admin" | "member";

export interface TeamManagerProps {
  readonly result: TeamResult;
  /** Roles the caller may grant (server-derived from their own role). The invite form offers exactly these. */
  readonly grantableRoles: readonly MembershipRole[];
  /** Whether the caller may invite/revoke (owner/admin). Server-derived; the actions re-check regardless. */
  readonly canManage: boolean;
  readonly createInvite: (formData: FormData) => Promise<CreateInviteResult>;
  readonly revokeInvite: (formData: FormData) => Promise<RevokeInviteResult>;
}

/** A one-time-ish share link for a freshly-created invite (full URL built from the current origin). */
function acceptUrl(acceptPath: string): string {
  if (typeof window === "undefined") return acceptPath;
  return `${window.location.origin}${acceptPath}`;
}

/** Sentence-case a role for display (the value stays lowercase). */
function roleLabel(role: string): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

export function TeamManager({
  result,
  grantableRoles,
  canManage,
  createInvite,
  revokeInvite,
}: TeamManagerProps) {
  const [invites, setInvites] = React.useState<readonly PendingInvite[]>(
    result.status === "ok" ? result.invites : [],
  );
  const [inviteOpen, setInviteOpen] = React.useState(false);
  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState<string>(grantableRoles[0] ?? "member");
  const [pending, setPending] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);
  // The freshly-created invite's share link, held for the copy dialog.
  const [shareLink, setShareLink] = React.useState<{ email: string; url: string } | null>(null);
  // The invite the confirm dialog is asking to revoke, plus its in-flight/error state.
  const [revoking, setRevoking] = React.useState<PendingInvite | null>(null);
  const [revokePending, setRevokePending] = React.useState(false);
  const [revokeError, setRevokeError] = React.useState<string | null>(null);

  if (result.status !== "ok") {
    return (
      <Banner tone="danger">
        We couldn&apos;t load your team right now. Refresh the page to try again.
      </Banner>
    );
  }

  function resetForm() {
    setEmail("");
    setRole(grantableRoles[0] ?? "member");
    setFormError(null);
  }

  async function handleInvite(event: React.FormEvent) {
    event.preventDefault();
    setFormError(null);
    setPending(true);
    try {
      const fd = new FormData();
      fd.set("email", email.trim());
      fd.set("role", role);
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
      resetForm();
      setShareLink({ email: res.invitedEmail, url: acceptUrl(res.acceptPath) });
    } catch {
      setFormError("We couldn't create the invite. Please try again.");
    } finally {
      setPending(false);
    }
  }

  async function confirmRevoke() {
    if (!revoking) return;
    const target = revoking; // stable across the await
    setRevokePending(true);
    setRevokeError(null);
    try {
      const res = await revokeInvite(
        (() => {
          const fd = new FormData();
          fd.set("inviteId", target.id);
          return fd;
        })(),
      );
      if (res.status !== "ok") {
        setRevokeError(
          res.status === "forbidden"
            ? "You don't have permission to revoke invites."
            : "We couldn't revoke the invite. Please try again.",
        );
        return;
      }
      setInvites((prev) => prev.filter((i) => i.id !== target.id));
      setRevoking(null);
    } catch {
      setRevokeError("We couldn't revoke the invite. Please try again.");
    } finally {
      setRevokePending(false);
    }
  }

  const memberWord = result.memberCount === 1 ? "member" : "members";
  const canInvite = email.trim() !== "" && !pending;

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div className="flex flex-col gap-1.5">
              <CardTitle>Members</CardTitle>
              <CardDescription>
                {result.memberCount} {memberWord} · {result.ownerCount}{" "}
                {result.ownerCount === 1 ? "owner" : "owners"}. Invite teammates by email — they
                join once they accept.
              </CardDescription>
            </div>
            {canManage ? (
              <Dialog
                open={inviteOpen}
                onOpenChange={(open) => {
                  setInviteOpen(open);
                  if (!open) resetForm();
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
                        value={role}
                        disabled={pending}
                        onChange={(e) => setRole(e.target.value)}
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
          {invites.length === 0 ? (
            <p className="text-sm text-fg-secondary">No pending invites.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-hairline">
              {invites.map((invite) => (
                <li key={invite.id} className="flex items-center justify-between gap-4 py-3">
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="truncate font-medium text-fg">{invite.invitedEmail}</span>
                    <span className="text-xs text-fg-secondary">
                      Invited · expires {new Date(invite.expiresAt).toLocaleDateString()}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <Badge tone="neutral">{roleLabel(invite.role)}</Badge>
                    {canManage ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                          setRevokeError(null);
                          setRevoking(invite);
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

      {/* Revoke confirm */}
      <Dialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (open || revokePending) return;
          setRevoking(null);
          setRevokeError(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke invite?</DialogTitle>
            <DialogDescription>
              {revoking
                ? `The link sent to "${revoking.invitedEmail}" will stop working. This can't be undone.`
                : null}
            </DialogDescription>
          </DialogHeader>
          {revokeError ? <Banner tone="danger">{revokeError}</Banner> : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="secondary" disabled={revokePending}>
                Cancel
              </Button>
            </DialogClose>
            <Button variant="danger" onClick={confirmRevoke} disabled={revokePending}>
              Revoke invite
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Share-link reveal after a successful invite */}
      <Dialog open={shareLink !== null} onOpenChange={(open) => !open && setShareLink(null)}>
        <DialogContent hideCloseButton>
          <DialogHeader>
            <DialogTitle>Share the invite link</DialogTitle>
            <DialogDescription>
              {shareLink ? `Send this link to ${shareLink.email} so they can join.` : null}
            </DialogDescription>
          </DialogHeader>
          <Banner tone="info">
            Copy it now — for their security, the link isn&apos;t shown again here.
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
