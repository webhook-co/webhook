import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CreateInviteResult, RevokeInviteResult } from "@/server/invite-actions";
import type { TeamResult } from "@/server/team";

import { TeamManager } from "./team-manager";

const INVITE = {
  id: "inv_1",
  invitedEmail: "bob@acme.test",
  role: "member" as const,
  start: "whinv_ab",
  expiresAt: "2026-07-19T00:00:00.000Z",
  createdAt: "2026-07-12T00:00:00.000Z",
};

function okResult(overrides: Partial<Extract<TeamResult, { status: "ok" }>> = {}): TeamResult {
  return {
    status: "ok",
    role: "owner",
    memberCount: 3,
    ownerCount: 1,
    invites: [INVITE],
    ...overrides,
  };
}

const created: CreateInviteResult = {
  status: "ok",
  acceptPath: "/invite/accept?org=org_1&token=whinv_secret",
  invitedEmail: "bob@acme.test",
  role: "member",
};

function renderManager(
  result: TeamResult,
  opts: {
    createInvite?: (fd: FormData) => Promise<CreateInviteResult>;
    revokeInvite?: (fd: FormData) => Promise<RevokeInviteResult>;
    grantableRoles?: readonly ("owner" | "admin" | "member")[];
    canManage?: boolean;
  } = {},
) {
  return render(
    <TeamManager
      result={result}
      grantableRoles={opts.grantableRoles ?? ["owner", "admin", "member"]}
      canManage={opts.canManage ?? true}
      createInvite={opts.createInvite ?? vi.fn()}
      revokeInvite={opts.revokeInvite ?? vi.fn()}
    />,
  );
}

beforeEach(() => vi.clearAllMocks());

describe("TeamManager", () => {
  it("lists pending invites with their email and role", () => {
    renderManager(okResult());
    expect(screen.getByText("bob@acme.test")).toBeInTheDocument();
    // The role badge is sentence-cased ("Member") — distinct from the lowercase "3 members" count.
    expect(screen.getByText("Member")).toBeInTheDocument();
  });

  it("offers an invite affordance to an owner/admin", () => {
    renderManager(okResult(), { canManage: true });
    expect(screen.getByRole("button", { name: /invite/i })).toBeInTheDocument();
  });

  it("hides invite AND revoke from a plain member (read-only view)", () => {
    renderManager(okResult({ role: "member" }), { canManage: false });
    expect(screen.queryByRole("button", { name: /invite/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /revoke/i })).not.toBeInTheDocument();
  });

  it("submits the invite and shows the shareable accept link", async () => {
    const user = userEvent.setup();
    const createInvite = vi.fn(async () => created);
    renderManager(okResult({ invites: [] }), { createInvite });

    await user.click(screen.getByRole("button", { name: /invite/i }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/email/i), "bob@acme.test");
    await user.click(within(dialog).getByRole("button", { name: /send invite/i }));

    // The action was called with the typed email (role defaults to the first grantable).
    await waitFor(() => expect(createInvite).toHaveBeenCalledTimes(1));
    const fd = createInvite.mock.calls[0][0] as FormData;
    expect(fd.get("email")).toBe("bob@acme.test");

    // The shareable link (origin + acceptPath) is revealed for copying.
    const link = await screen.findByText(/\/invite\/accept\?org=org_1&token=whinv_secret/);
    expect(link).toBeInTheDocument();
  });

  it("surfaces a server rejection as an error, without a link", async () => {
    const user = userEvent.setup();
    // The email is well-formed (passes the native + client check); the SERVER still rejects it (e.g. the
    // person is already a member) — the dialog must surface that reason and reveal no link.
    const createInvite = vi.fn(async () => ({
      status: "invalid" as const,
      message: "That email is already a member.",
    }));
    renderManager(okResult({ invites: [] }), { createInvite });

    await user.click(screen.getByRole("button", { name: /invite/i }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/email/i), "bob@acme.test");
    await user.click(within(dialog).getByRole("button", { name: /send invite/i }));

    expect(await within(dialog).findByText(/already a member/i)).toBeInTheDocument();
    expect(screen.queryByText(/\/invite\/accept/)).not.toBeInTheDocument();
  });

  it("revokes an invite and drops it from the list", async () => {
    const user = userEvent.setup();
    const revokeInvite = vi.fn(async () => ({ status: "ok" }) as RevokeInviteResult);
    renderManager(okResult(), { revokeInvite });

    await user.click(screen.getByRole("button", { name: /revoke/i }));
    // Confirm in the dialog.
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /revoke invite/i }));

    await waitFor(() => expect(revokeInvite).toHaveBeenCalledTimes(1));
    const fd = revokeInvite.mock.calls[0][0] as FormData;
    expect(fd.get("inviteId")).toBe("inv_1");
    await waitFor(() => expect(screen.queryByText("bob@acme.test")).not.toBeInTheDocument());
  });

  it("renders an error state when the load failed", () => {
    renderManager({ status: "error" });
    expect(screen.getByText(/couldn't load/i)).toBeInTheDocument();
  });
});
