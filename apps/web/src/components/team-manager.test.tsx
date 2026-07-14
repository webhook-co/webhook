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
  emailed: true,
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
    leaveOrg?: () => Promise<{ status: "last_owner" | "error" }>;
    isPersonalOrg?: boolean;
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
      leaveOrg={opts.leaveOrg ?? vi.fn(async () => ({ status: "error" }) as const)}
      isPersonalOrg={opts.isPersonalOrg ?? false}
    />,
  );
}

/** The table row for a given member's (or invitee's) email. Members and invites share ONE table now — an
 *  invite is just a row whose Status is Pending. */
function memberRow(email: string): HTMLElement {
  return screen.getByText(email).closest("tr") as HTMLElement;
}

/** The row's `…` actions menu. Its absence IS the authorization assertion in several tests below: if you may
 *  not act on someone, there is no menu on their row at all. */
function rowActions(email: string): HTMLElement | null {
  return within(memberRow(email)).queryByRole("button", { name: /^actions for/i });
}

async function openRowActions(user: ReturnType<typeof userEvent.setup>, email: string) {
  const trigger = rowActions(email);
  if (!trigger) throw new Error(`no actions menu on the row for ${email}`);
  await user.click(trigger);
}

beforeEach(() => vi.clearAllMocks());

describe("TeamManager — members", () => {
  it("lists every member with their identity and role", () => {
    renderManager(okResult());
    expect(screen.getByText("olive@acme.test")).toBeInTheDocument();
    expect(screen.getByText("Bob Member")).toBeInTheDocument();
    // Role is now a COLUMN, not a form control — the row states what someone is; the `…` menu is where you
    // change it. A picker sitting in every row implied the role was a field you were editing, and made the
    // read-only view (a plain member) look broken rather than read-only.
    const bob = memberRow("bob@acme.test");
    expect(within(bob).getByText("Member")).toBeInTheDocument();
    expect(within(bob).getByText("Active")).toBeInTheDocument();
  });

  it("marks your own row and offers NO controls on it (you can't remove yourself here)", () => {
    renderManager(okResult());
    const own = memberRow("olive@acme.test");
    expect(within(own).getByText(/you/i)).toBeInTheDocument();
    // No menu at all on your own row — not a menu with the dangerous items removed.
    expect(rowActions("olive@acme.test")).toBeNull();
  });

  it("gives an ADMIN no controls over an OWNER (you cannot act on someone who outranks you)", () => {
    renderManager(okResult({ role: "admin", userId: "u_admin" }), {
      grantableRoles: ["admin", "member"],
    });
    expect(rowActions("olive@acme.test")).toBeNull();
    // …but it can still act on a plain member.
    expect(rowActions("bob@acme.test")).not.toBeNull();
  });

  it("hides all member controls from a plain member (read-only view)", () => {
    renderManager(okResult({ role: "member", userId: "u_bob" }), { canManage: false });
    expect(screen.queryByRole("button", { name: /^actions for/i })).not.toBeInTheDocument();
  });

  it("removes a member after confirming, and warns that their credentials die", async () => {
    const user = userEvent.setup();
    const removeMember = vi.fn(async () => ({ status: "ok" }) as MemberActionResult);
    renderManager(okResult(), { removeMember });

    await openRowActions(user, "bob@acme.test");
    await user.click(await screen.findByRole("menuitem", { name: /remove from organization/i }));
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

    // Demote the admin to member. The menu offers only roles they do NOT already hold — an item that changes
    // nothing is not an action.
    await openRowActions(user, "adam@acme.test");
    await user.click(await screen.findByRole("menuitem", { name: /make member/i }));
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

    await openRowActions(user, "adam@acme.test");
    await user.click(await screen.findByRole("menuitem", { name: /remove from organization/i }));
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
    // Named exactly: a loose /invite/i now also matches a row's "Actions for the invite to …" menu.
    expect(screen.getByRole("button", { name: "Invite teammate" })).toBeInTheDocument();
  });

  it("hides invite AND revoke from a plain member", () => {
    renderManager(okResult({ role: "member", userId: "u_bob" }), { canManage: false });
    expect(screen.queryByRole("button", { name: "Invite teammate" })).not.toBeInTheDocument();
    // Revoke lives in the row's `…` menu now, so "no menu on the row" IS "no revoke".
    expect(screen.queryByRole("button", { name: /^actions for/i })).not.toBeInTheDocument();
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

  it("says the invite was EMAILED when it was, and still offers the link", async () => {
    const user = userEvent.setup();
    renderManager(okResult({ invites: [] }), { createInvite: vi.fn(async () => created) });

    await user.click(screen.getByRole("button", { name: /invite/i }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/email/i), "carol@acme.test");
    await user.click(within(dialog).getByRole("button", { name: /send invite/i }));

    expect(
      await screen.findByText(/we emailed the invite to carol@acme.test/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/\/invite\/accept\?org=org_1&token=whinv_secret/)).toBeInTheDocument();
  });

  it("does NOT claim an email was sent when it wasn't — it tells you to copy the link", async () => {
    const user = userEvent.setup();
    const createInvite = vi.fn(async () => ({ ...created, emailed: false }));
    renderManager(okResult({ invites: [] }), { createInvite });

    await user.click(screen.getByRole("button", { name: /invite/i }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/email/i), "carol@acme.test");
    await user.click(within(dialog).getByRole("button", { name: /send invite/i }));

    expect(await screen.findByText(/couldn't email it/i)).toBeInTheDocument();
    expect(screen.queryByText(/we emailed the invite/i)).not.toBeInTheDocument();
    // THE POINT of this path: mail didn't go out, so the link MUST still be there to copy. Without this
    // assertion a regression that hid the link whenever `emailed` was false would pass — and the invite
    // would be unrecoverable: created, un-emailed, and un-shareable.
    expect(screen.getByText(/\/invite\/accept\?org=org_1&token=whinv_secret/)).toBeInTheDocument();
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

    await openRowActions(user, "carol@acme.test");
    await user.click(await screen.findByRole("menuitem", { name: /revoke invite/i }));
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

// Leaving (Lane 2.9). Member removal is owner/admin-only AND refuses your own row, so without this an invited
// teammate had NO WAY OUT of a team — they could be removed, but never leave.
describe("TeamManager — leaving", () => {
  it("offers Leave organization in a shared org", () => {
    renderManager(okResult({ role: "member", userId: "u_bob" }), { canManage: false });
    expect(screen.getByRole("button", { name: /leave organization/i })).toBeInTheDocument();
  });

  it("does NOT offer it for your own personal org — that's what deleting the account is for", () => {
    renderManager(okResult(), { isPersonalOrg: true });
    expect(screen.queryByRole("button", { name: /leave organization/i })).not.toBeInTheDocument();
  });

  it("warns that your keys die, then leaves on confirm", async () => {
    const user = userEvent.setup();
    // Success REDIRECTS, so the action never returns; a throw stands in for that here.
    // Stand-in for the redirect: the real action never returns on success.
    const leaveOrg = vi.fn(async () => new Promise<never>(() => {}));
    renderManager(okResult({ role: "member", userId: "u_bob" }), {
      canManage: false,
      leaveOrg: leaveOrg as never,
    });

    await user.click(screen.getByRole("button", { name: /leave organization/i }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/api keys and devices/i)).toBeInTheDocument();
    // The real action redirects (which throws Next's signal); assert only that we asked to leave.
    await user.click(within(dialog).getByRole("button", { name: /leave organization/i }));
    await waitFor(() => expect(leaveOrg).toHaveBeenCalledTimes(1));
  });

  it("tells a SOLE OWNER what to do instead of just refusing", async () => {
    const user = userEvent.setup();
    const leaveOrg = vi.fn(async () => ({ status: "last_owner" }) as const);
    renderManager(okResult(), { leaveOrg });

    await user.click(screen.getByRole("button", { name: /leave organization/i }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /leave organization/i }));

    // Actionable: name the way out (promote someone), not just "you can't".
    expect(await screen.findByText(/make someone else an owner first/i)).toBeInTheDocument();
  });
});

// The page used to be TWO cards — "Members" (a <ul>) and "Pending invites" (another <ul>) — with different
// shapes and different controls. But nobody arrives asking those as separate questions. They ask WHO HAS OR IS
// GETTING ACCESS, and the answer was split in half. An invite is just a member whose status is Pending.
describe("TeamManager — one table", () => {
  it("puts members and invites in the SAME table, told apart by Status", () => {
    renderManager(okResult());

    const rows = screen.getAllByRole("row");
    // header + 3 members + 1 invite
    expect(rows).toHaveLength(5);

    expect(within(memberRow("bob@acme.test")).getByText("Active")).toBeInTheDocument();
    expect(within(memberRow("carol@acme.test")).getByText("Pending")).toBeInTheDocument();
  });

  it("has the columns you actually need: Name, Email, Role, Status", () => {
    renderManager(okResult());

    for (const column of ["Name", "Email", "Role", "Status"]) {
      expect(screen.getByRole("columnheader", { name: column })).toBeInTheDocument();
    }
  });

  // An invited person has NO NAME — they have not accepted, so we have never met them. Echoing their email
  // into the Name column would be inventing data we do not have.
  it("leaves an invitee's name blank rather than repeating their email", () => {
    renderManager(okResult());

    const carol = memberRow("carol@acme.test");
    const cells = within(carol).getAllByRole("cell");
    expect(cells[0]).toHaveTextContent("—");
    expect(cells[1]).toHaveTextContent("carol@acme.test");
  });

  // The role picker was a NATIVE <select>: it renders as the OS's own widget — a different typeface, a
  // different focus ring, a different popover on every platform — inside a dialog that is otherwise entirely
  // ours. The same Combobox already picks a provider elsewhere; a role is the same kind of choice.
  it("picks the invite role with our Combobox, not a native select", async () => {
    const user = userEvent.setup();
    const createInvite = vi.fn(async () => ({ status: "ok" }) as CreateInviteResult);
    renderManager(okResult(), { createInvite });

    await user.click(screen.getByRole("button", { name: "Invite teammate" }));
    const dialog = await screen.findByRole("dialog");

    // A native <select> IS a <select> element. Ours is a button that opens a listbox — so asserting the
    // element is gone is what actually pins the swap (a role query alone would not: both expose a combobox).
    expect(dialog.querySelector("select")).toBeNull();
    // Our trigger announces "{label}: {current}", so it names the role you currently have selected.
    expect(within(dialog).getByRole("button", { name: /^role:/i })).toBeInTheDocument();
  });

  it("sends the role chosen in the Combobox", async () => {
    const user = userEvent.setup();
    const createInvite = vi.fn(async () => ({ status: "ok" }) as CreateInviteResult);
    renderManager(okResult(), { createInvite });

    await user.click(screen.getByRole("button", { name: "Invite teammate" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/email/i), "new@acme.test");

    await user.click(within(dialog).getByRole("button", { name: /^role:/i }));
    await user.click(await screen.findByRole("option", { name: "Admin" }));
    await user.click(within(dialog).getByRole("button", { name: /send invite/i }));

    await waitFor(() => expect(createInvite).toHaveBeenCalledTimes(1));
    const fd = createInvite.mock.calls[0][0] as FormData;
    expect(fd.get("email")).toBe("new@acme.test");
    expect(fd.get("role")).toBe("admin");
  });
});

// A REAL BUG, found by opening the page in a browser — not by any of the 1000+ tests, because jsdom does not
// hydrate and therefore cannot see a hydration mismatch.
//
// The expiry was rendered with a bare `toLocaleDateString()`. The server (Node) produced "21/07/2026" and the
// browser produced "21/7/2026", so React threw away the server-rendered HTML and re-rendered the whole tree on
// the client. Silent, and invisible to the suite.
//
// The fix pins BOTH the locale and the time zone, and this test is what stops a future `toLocaleDateString()`
// creeping back: it renders the row under a NON-default locale and time zone and demands the same string.
describe("TeamManager — the invite expiry survives hydration", () => {
  const EXPIRES = "2026-07-21T09:00:00.000Z";

  function expiryTextUnder(locales: string[], timeZone: string): string {
    const original = Intl.DateTimeFormat;
    // Stand in for a browser whose locale/zone differ from the server's — which is the ONLY reason the bug
    // existed. If the component is deterministic, this changes nothing.
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(
      ((l?: unknown, o?: Intl.DateTimeFormatOptions) =>
        new original(
          (l as string) ?? locales,
          o ? { ...o, timeZone: o.timeZone ?? timeZone } : { timeZone },
        )) as unknown as typeof Intl.DateTimeFormat,
    );
    const invite = { ...INVITE, expiresAt: EXPIRES };
    const { unmount } = renderManager(okResult({ invites: [invite] }));
    const text = within(memberRow("carol@acme.test")).getByText(/expires/i).textContent ?? "";
    unmount();
    vi.restoreAllMocks();
    return text;
  }

  it("renders the SAME expiry regardless of the environment's locale and time zone", () => {
    const asServer = expiryTextUnder(["en-US"], "America/New_York");
    const asBrowser = expiryTextUnder(["de-DE"], "Asia/Kolkata");

    // Server HTML and client HTML must be byte-identical, or React discards the server render.
    expect(asBrowser).toBe(asServer);
    // Spelled-out month, so it is also unambiguous — a numeric date would still read as 21/07 or 07/21
    // depending on who is looking at it.
    expect(asServer).toContain("Jul");
    expect(asServer).toContain("2026");
  });
});
