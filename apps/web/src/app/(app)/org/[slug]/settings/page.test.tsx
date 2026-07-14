import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// requireOrgAccess now carries the org's authoritative `name` (from the directory read that proved
// membership), so the page renders the rename card WITHOUT a second directory query.
vi.mock("@/server/org-access", () => ({
  requireOrgAccess: vi.fn(async () => ({
    userId: "usr_1",
    orgId: "org_1",
    slug: "acme",
    name: "Acme",
    role: "owner",
    user: { name: "Dana Kessler", email: "dana@acme.co", image: null },
  })),
}));
vi.mock("@/server/auth-actions", () => ({ logout: vi.fn() }));
vi.mock("@/server/org-actions", () => ({ renameOrgAction: vi.fn() }));
// The page now asks isPersonalOrg (org-centric) whether to render the delete-org card; it needs a db
// client to do so. Stub both: a bare client, and isPersonalOrg → false (a regular team org shows the card).
vi.mock("@/server/db", () => ({ getTenantDb: async () => ({}) }));
vi.mock("@webhook-co/db/org-lifecycle", () => ({ isPersonalOrg: async () => false }));

import SettingsPage from "./page";

describe("SettingsPage", () => {
  it("is about the ORG — its name and its address", async () => {
    render(await SettingsPage({ params: Promise.resolve({ slug: "acme" }) }));

    expect(screen.getByRole("heading", { name: "Organization settings" })).toBeInTheDocument();
    // The rename card is the primary org control on this page: name + URL, editable by an owner.
    expect(screen.getByLabelText("Name")).toHaveValue("Acme");
    expect(screen.getByLabelText("URL")).toHaveValue("acme");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeInTheDocument();
  });

  // Everything USER-scoped moved to /account, and the point is not tidiness.
  //
  // The Account card, Connected apps and Delete account all rendered IDENTICALLY under every org in the
  // switcher, because none of them depended on the org — `loadConnectedApps()` does not even take an `orgId`.
  // That invites a genuinely dangerous reading: that revoking Claude's access in Acme leaves it connected in
  // your personal org. It does not. There is one grant, and revoking it revokes it everywhere. A user acting
  // on that belief thinks they have contained something they have not.
  //
  // These assertions are the ones that would go red if any of it crept back.
  it("carries NO user-scoped controls — they are facts about you, not about this org", async () => {
    render(await SettingsPage({ params: Promise.resolve({ slug: "acme" }) }));

    // Not the signed-in identity…
    expect(screen.queryByText("dana@acme.co")).not.toBeInTheDocument();
    // …not the connected-apps CARD (the same OAuth grants rendered under every org). The page may still
    // MENTION them — it points you to where they went, which is the opposite of hiding them — so this asserts
    // there is no card and no control, not that the words never appear.
    expect(screen.queryByRole("heading", { name: /connected apps/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /manage connected apps/i })).not.toBeInTheDocument();
    // …not deleting your account, which erases you across every org you are in…
    expect(screen.queryByRole("button", { name: /delete (my )?account/i })).not.toBeInTheDocument();
    // …and not Log out, which is a session action and now lives in the account menu where you look for it.
    expect(screen.queryByRole("button", { name: "Log out" })).not.toBeInTheDocument();
  });

  it("points you at /account for the things that moved", async () => {
    render(await SettingsPage({ params: Promise.resolve({ slug: "acme" }) }));

    // Moving something without saying where is just losing it.
    expect(screen.getByRole("link", { name: /account/i })).toHaveAttribute("href", "/account");
  });
});
