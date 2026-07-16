import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LoginMethod } from "@webhook-co/contract";

import { LoginMethodsManager } from "./login-methods-manager";

const disconnect = vi.fn();
const methods: LoginMethod[] = [
  { providerId: "google", accountId: "g-1", linkedAt: 1_700_000_000 },
  { providerId: "github", accountId: "gh-1", linkedAt: 1_700_100_000 },
];

beforeEach(() => {
  vi.clearAllMocks();
  disconnect.mockResolvedValue({ ok: true });
});
afterEach(cleanup);

describe("LoginMethodsManager", () => {
  it("lists linked providers by friendly name and offers a disconnect for each", () => {
    render(<LoginMethodsManager initialMethods={methods} hasMagicLink disconnect={disconnect} />);
    expect(screen.getByText("Google")).toBeInTheDocument();
    expect(screen.getByText("GitHub")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /disconnect/i })).toHaveLength(2);
  });

  it("renders EVERY provider row, connected or not — an unlinked one is a state, not an absence", () => {
    render(<LoginMethodsManager initialMethods={[]} hasMagicLink disconnect={disconnect} />);
    // Both rows present with nothing linked at all.
    expect(screen.getByText("Google")).toBeInTheDocument();
    expect(screen.getByText("GitHub")).toBeInTheDocument();
    expect(screen.getAllByText(/not connected/i)).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /disconnect/i })).toBeNull();
  });

  it("shows Disconnect ONLY on connected rows, and in the danger tone", () => {
    render(
      <LoginMethodsManager initialMethods={[methods[0]!]} hasMagicLink disconnect={disconnect} />,
    );
    const buttons = screen.getAllByRole("button", { name: /disconnect/i });
    expect(buttons).toHaveLength(1); // google only — github is unlinked
    // Destructive, and it must LOOK destructive: this is the button that removes a way into your account.
    expect(buttons[0]!.className).toMatch(/bg-danger/);
    expect(screen.getByText(/not connected/i)).toBeInTheDocument(); // the github row
  });

  it("flips a row to 'not connected' in place on a successful disconnect — the row stays", async () => {
    render(<LoginMethodsManager initialMethods={methods} hasMagicLink disconnect={disconnect} />);
    fireEvent.click(screen.getAllByRole("button", { name: /disconnect/i })[0]!);

    await waitFor(() => expect(disconnect).toHaveBeenCalledWith("google", "g-1"));
    // The ROW persists (that's the point) — what changes is its state and the loss of its button.
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: /disconnect/i })).toHaveLength(1),
    );
    expect(screen.getByText("Google")).toBeInTheDocument();
    expect(screen.getByText(/not connected/i)).toBeInTheDocument();
    expect(screen.getByText(/^Connected /)).toBeInTheDocument(); // github still is
  });

  it("surfaces the last-method guard error and keeps the method listed", async () => {
    disconnect.mockResolvedValue({
      ok: false,
      error: "That's your only way to sign in — add another sign-in method first.",
      reason: "last_method",
    });
    render(
      <LoginMethodsManager
        initialMethods={[methods[0]!]}
        hasMagicLink={false}
        disconnect={disconnect}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /disconnect/i }));

    expect(await screen.findByText(/only way to sign in/i)).toBeInTheDocument();
    expect(screen.getByText("Google")).toBeInTheDocument(); // not removed
  });

  it("says how to connect an unlinked provider, per row, naming that provider", () => {
    // Not a "Connect" button: linking needs Better Auth's linkSocial on the AUTH origin, and there is no such
    // route (and /login bounces a signed-in user to /session/handoff, so it can't be borrowed). Until that
    // exists, signing in with the provider IS the link — the pinned verified-email auto-link does it. A
    // button that only said "Connect" and then explained you have to sign out would be worse than saying so.
    render(<LoginMethodsManager initialMethods={[]} hasMagicLink disconnect={disconnect} />);
    expect(screen.getByText(/sign in with Google using this email/i)).toBeInTheDocument();
    expect(screen.getByText(/sign in with GitHub using this email/i)).toBeInTheDocument();
  });

  it("mentions the magic link only when it's actually available", () => {
    const { rerender } = render(
      <LoginMethodsManager initialMethods={methods} hasMagicLink disconnect={disconnect} />,
    );
    expect(screen.getByText(/magic link to your email/i)).toBeInTheDocument();

    rerender(
      <LoginMethodsManager initialMethods={methods} hasMagicLink={false} disconnect={disconnect} />,
    );
    expect(screen.queryByText(/magic link to your email/i)).toBeNull();
  });
});
