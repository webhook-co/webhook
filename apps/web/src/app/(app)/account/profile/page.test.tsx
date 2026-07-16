import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { verifySession } = vi.hoisted(() => ({
  verifySession: vi.fn(async () => ({ user: { name: "Dana Doe", email: "dana@example.com" } })),
}));
vi.mock("@/server/session", () => ({ verifySession }));
// The delete card imports a server action; stub it so this server-component render stays pure.
vi.mock("@/components/delete-account-card", () => ({
  DeleteAccountCard: () => <div>delete-account-card</div>,
}));
// The editable name card injects this server action; stub the module so the page render stays pure.
vi.mock("@/server/profile-actions", () => ({ updateDisplayNameAction: vi.fn() }));
// EditableDisplayName is a client component that calls useRouter — provide a router.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import AccountProfilePage from "./page";

describe("account/profile page", () => {
  it("renders the profile (name + email) and the delete-account card", async () => {
    render(await AccountProfilePage());
    expect(screen.getByText("Dana Doe")).toBeInTheDocument();
    expect(screen.getByText("dana@example.com")).toBeInTheDocument();
    expect(screen.getByText("delete-account-card")).toBeInTheDocument();
    // The page heading is "Profile" (it's the profile route now, not the account index)…
    expect(screen.getByRole("heading", { name: "Profile", level: 1 })).toBeInTheDocument();
    // …and it appears exactly ONCE — the identity card no longer repeats a "Profile" title under the h1.
    expect(screen.getAllByText("Profile")).toHaveLength(1);
  });

  it("says where to change the email, and links there — the Edit button only edits the NAME", async () => {
    // Without this, the card shows your email beside an "Edit" that pointedly won't touch it, which reads as
    // a broken control rather than a deliberate scope. The email change is a verified ceremony (code to the
    // current address, other sessions revoked) so it can't be an inline field here — but silence about that
    // just leaves the reader poking at the wrong button.
    render(await AccountProfilePage());
    const link = screen.getByRole("link", { name: /login & security/i });
    expect(link).toHaveAttribute("href", "/account/security");
    expect(screen.getByText(/we send a code to your current address/i)).toBeInTheDocument();
  });

  it("must NOT claim the NEW address is verified — the OTP goes to the CURRENT one", async () => {
    // email-change-core does `sendOtpEmail(profile.email, code)` and the contract says "OTP to the user's
    // CURRENT email"; the new address is never contacted before the write. A draft here promised "we verify
    // the new address before it takes effect", which inverts that and is actively dangerous: it tells you a
    // typo will be caught, so you paste the code from the inbox you DO own and the account moves to one you
    // don't — every other session revoked behind you. The first version of this test asserted the false
    // sentence, which is why the copy shipped.
    render(await AccountProfilePage());
    const copy = document.body.textContent ?? "";
    expect(copy).not.toMatch(
      /verify the new address|confirm the new address|check the new address/i,
    );
  });

  it("gates on the session — the page must call verifySession (a mocked gate is only tested if we assert it ran)", async () => {
    render(await AccountProfilePage());
    expect(verifySession).toHaveBeenCalled();
  });
});
