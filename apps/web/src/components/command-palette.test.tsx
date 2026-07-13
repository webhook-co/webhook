import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useParams: () => ({ slug: "acme" }),
  useRouter: () => ({ push }),
}));

import { COMMAND_ITEMS } from "./app-nav";
import { CommandPalette } from "./command-palette";

const ITEMS = [
  { href: "/credentials", label: "Credentials", keywords: ["keys"] },
  { href: "/deliveries", label: "Deliveries" },
];

beforeEach(() => vi.clearAllMocks());

/** ⌘K on the document (not in a field). */
async function openPalette(user: ReturnType<typeof userEvent.setup>) {
  await user.keyboard("{Meta>}k{/Meta}");
  return screen.findByRole("dialog");
}

describe("CommandPalette", () => {
  it("is closed until ⌘K", async () => {
    const user = userEvent.setup();
    render(<CommandPalette items={ITEMS} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await openPalette(user);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("finds a page by a KEYWORD, not just its label — 'keys' finds Credentials", async () => {
    const user = userEvent.setup();
    render(<CommandPalette items={ITEMS} />);
    await openPalette(user);

    await user.type(screen.getByRole("textbox", { name: /search pages/i }), "keys");
    expect(screen.getByRole("button", { name: "Credentials" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Deliveries" })).not.toBeInTheDocument();
  });

  it("navigates on Enter", async () => {
    const user = userEvent.setup();
    render(<CommandPalette items={ITEMS} />);
    await openPalette(user);

    await user.type(screen.getByRole("textbox", { name: /search pages/i }), "deliv");
    await user.keyboard("{Enter}");

    await waitFor(() => expect(push).toHaveBeenCalledWith("/deliveries"));
  });

  it("says so when nothing matches, rather than showing an empty box", async () => {
    const user = userEvent.setup();
    render(<CommandPalette items={ITEMS} />);
    await openPalette(user);
    await user.type(screen.getByRole("textbox", { name: /search pages/i }), "zzzz");
    expect(screen.getByText(/no pages match/i)).toBeInTheDocument();
  });

  it("does NOT hijack ⌘K while the user is typing in a field", async () => {
    // Stealing ⌘K out of an input is how a palette becomes hostile.
    const user = userEvent.setup();
    render(
      <>
        <input aria-label="somewhere else" />
        <CommandPalette items={ITEMS} />
      </>,
    );
    await user.click(screen.getByLabelText("somewhere else"));
    await user.keyboard("{Meta>}k{/Meta}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("the palette and the sidebar cannot drift apart", () => {
  it("offers every nav route, org-scoped (they're derived from one table)", () => {
    // A page in the sidebar but not the palette (or vice-versa) is drift nobody notices until a user
    // complains. Both come from the same NAV table; this pins that they stay that way.
    //
    // Every href is now rooted at /org/{slug}: the org comes from the URL, so a bare `/dashboard` would be a
    // 404 — and a palette that navigates you off the org tree is exactly the silent breakage the move exists
    // to delete. Pin the PREFIX, not just the tail.
    const items = COMMAND_ITEMS("acme");
    const hrefs = items.map((i) => i.href);
    expect(hrefs).toContain("/org/acme/dashboard");
    expect(hrefs).toContain("/org/acme/audit");
    expect(hrefs).toContain("/org/acme/team");
    expect(new Set(hrefs).size).toBe(hrefs.length); // no duplicates
    for (const item of items) {
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.href.startsWith("/org/acme/")).toBe(true);
    }
  });
});
