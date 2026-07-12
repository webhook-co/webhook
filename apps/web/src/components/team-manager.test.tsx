import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CreateInviteResult, RevokeInviteResult } from "@/server/invite-actions";
import type { MemberActionResult } from "@/server/member-actions";
import type { TeamResult } from "@/server/team";

import { TeamManager } from "./team-manager";

const INVITE = {
  id: "inv_1",
  invitedEmail: "carol@acme.test",
  role: "member" as const,
  start: "whinv_ab",
  expiresAt: "2026-07-19T00:00:00.000Z",
  createdAt: "2026-07-12T00:00:00.000Z",
};

const OWNER = {
  userId: "u_owner",
  name: "Olive Owner",
  email: "olive@acme.test",
  role: "owner" as const,
  joinedAt: "2026-06-01T00:00:00.000Z",
};
const ADMIN = {
  userId: "u_admin",
  name: "Adam Admin",
  email: "adam@acme.test",
  role: "admin" as const,
  joinedAt: "2026-06-02T00:00:00.000Z",
};
const MEMBER = {
  userId: "u_bob",
  name: "Bob Member",
  email: "bob@acme.test",
  role: "member" as const,
  joinedAt: "2026-07-01T00:00:00.000Z",
};

function okResult(overrides: Partial<Extract<TeamResult, { status: "ok" }>> = {}): TeamResult {
  return {
    status: "ok",
    role: "owner",
    userId: "u_owner",
    members: [OWNER, ADMIN, MEMBER],
    invites: [INVITE],
    ...overrides,
  };
}

const created: CreateInviteResult = {
  status: "ok",
  acceptPath: "/invite/accept?org=org_1&token=whinv_secret",
  invitedEmail: "carol@acme.test",
  role: "member",
};

function renderManager(
  result: TeamResult,
  opts: {
    createInvite?: (fd: FormData) => Promise<CreateInviteResult>;
    revokeInvite?: (fd: FormData) => Promise<RevokeInviteResult>;
    changeRole?: (fd: FormData) => Promise<MemberActionResult>;
    removeMember?: (fd: FormData) => Promise<MemberActionResult>;
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
      changeRole={opts.changeRole ?? vi.fn(async () => ({ status: "ok" }) as MemberActionResult)}
      removeMember={
        opts.removeMember ?? vi.fn(async () => ({ status: "ok" }) as MemberActionResult)
      }
    />,
  );
}

/** The <li> row for a given member's email. */
function memberRow(email: string): HTMLElement {
  return screen.getByText(email).closest("li") as HTMLElement;
}

beforeEach(() => vi.clearAllMocks());

describe("TeamManager — members", () => {
  it("lists every member with their identity and role", () => {
    renderManager(okResult());
    expect(screen.getByText("olive@acme.test")).toBeInTheDocument();
    expect(screen.getByText("Bob Member")).toBeInTheDocument();
    expect(within(memberRow("bob@acme.test")).getByDisplayValue("Member")).toBeInTheDocument();
  });

  it("marks your own row and offers NO controls on it (you can't remove yourself here)", () => {
    renderManager(okResult());
    const own = memberRow("olive@acme.test");
    expect(within(own).getByText(/you/i)).toBeInTheDocument();
    expect(within(own).queryByRole("button", { name: /remove/i })).not.toBeInTheDocument();
    expect(within(own).queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("gives an ADMIN no controls over an OWNER (you cannot act on someone who outranks you)", () => {
    renderManager(okResult({ role: "admin", userId: "u_admin" }), {
      grantableRoles: ["admin", "member"],
    });
    const ownersRow = memberRow("olive@acme.test");
    expect(within(ownersRow).queryByRole("button", { name: /remove/i })).not.toBeInTheDocument();
    expect(within(ownersRow).queryByRole("combobox")).not.toBeInTheDocument();
    // …but it can still act on a plain member.
    expect(
      within(memberRow("bob@acme.test")).getByRole("button", { name: /remove/i }),
    ).toBeInTheDocument();
  });

  it("hides all member controls from a plain member (read-only view)", () => {
    renderManager(okResult({ role: "member", userId: "u_bob" }), { canManage: false });
    expect(screen.queryByRole("button", { name: /remove/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("removes a member after confirming, and warns that their credentials die", async () => {
    const user = userEvent.setup();
    const removeMember = vi.fn(async () => ({ status: "ok" }) as MemberActionResult);
    renderManager(okResult(), { removeMember });

    await user.click(within(memberRow("bob@acme.test")).getByRole("button", { name: /remove/i }));
    const dialog = await screen.findByRole("dialog");
    // The consequence must be stated, not implied — removal revokes their keys and devices.
    expect(within(dialog).getByText(/api keys|credentials|keys/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: /remove member/i }));

    await waitFor(() => expect(removeMember).toHaveBeenCalledTimes(1));
    expect((removeMember.mock.calls[0][0] as FormData).get("userId")).toBe("u_bob");
    await waitFor(() => expect(screen.queryByText("bob@acme.test")).not.toBeInTheDocument());
  });

  it("confirms a DEMOTION before applying it — it revokes the member's keys", async () => {
    const user = userEvent.setup();
    const changeRole = vi.fn(async () => ({ status: "ok" }) as MemberActionResult);
    renderManager(okResult(), { changeRole });

    // Demote the admin to member.
    await user.selectOptions(within(memberRow("adam@acme.test")).getByRole("combobox"), "member");
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/keys/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: /change role/i }));

    await waitFor(() => expect(changeRole).toHaveBeenCalledTimes(1));
    const fd = changeRole.mock.calls[0][0] as FormData;
    expect(fd.get("userId")).toBe("u_admin");
    expect(fd.get("role")).toBe("member");
  });

  it("explains the last-owner refusal rather than showing a generic error", async () => {
    const user = userEvent.setup();
    const removeMember = vi.fn(async () => ({ status: "last_owner" }) as MemberActionResult);
    // A sole owner + one member; try to remove the owner (as… the owner can't act on self, so use an
    // org where the caller is an owner and there is a SECOND owner row to click).
    const secondOwner = { ...ADMIN, role: "owner" as const };
    renderManager(okResult({ members: [OWNER, secondOwner] }), { removeMember });

    await user.click(within(memberRow("adam@acme.test")).getByRole("button", { name: /remove/i }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /remove member/i }));

    expect(await within(dialog).findByText(/last owner|transfer ownership/i)).toBeInTheDocument();
  });
});

describe("TeamManager — invites", () => {
  it("lists pending invites with their email and role", () => {
    renderManager(okResult());
    expect(screen.getByText("carol@acme.test")).toBeInTheDocument();
  });

  it("offers an invite affordance to an owner/admin", () => {
    renderManager(okResult(), { canManage: true });
    expect(screen.getByRole("button", { name: /invite/i })).toBeInTheDocument();
  });

  it("hides invite AND revoke from a plain member", () => {
    renderManager(okResult({ role: "member", userId: "u_bob" }), { canManage: false });
    expect(screen.queryByRole("button", { name: /invite/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /revoke/i })).not.toBeInTheDocument();
  });

  it("submits the invite and shows the shareable accept link", async () => {
    const user = userEvent.setup();
    const createInvite = vi.fn(async () => created);
    renderManager(okResult({ invites: [] }), { createInvite });

    await user.click(screen.getByRole("button", { name: /invite/i }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/email/i), "carol@acme.test");
    await user.click(within(dialog).getByRole("button", { name: /send invite/i }));

    await waitFor(() => expect(createInvite).toHaveBeenCalledTimes(1));
    expect((createInvite.mock.calls[0][0] as FormData).get("email")).toBe("carol@acme.test");
    expect(
      await screen.findByText(/\/invite\/accept\?org=org_1&token=whinv_secret/),
    ).toBeInTheDocument();
  });

  it("surfaces a server rejection as an error, without a link", async () => {
    const user = userEvent.setup();
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

    await user.click(screen.getByRole("button", { name: /^revoke$/i }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /revoke invite/i }));

    await waitFor(() => expect(revokeInvite).toHaveBeenCalledTimes(1));
    expect((revokeInvite.mock.calls[0][0] as FormData).get("inviteId")).toBe("inv_1");
    await waitFor(() => expect(screen.queryByText("carol@acme.test")).not.toBeInTheDocument());
  });

  it("renders an error state when the load failed", () => {
    renderManager({ status: "error" });
    expect(screen.getByText(/couldn't load/i)).toBeInTheDocument();
  });
});
