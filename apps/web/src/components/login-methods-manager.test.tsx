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

  it("removes a method in place on a successful disconnect (targets the exact provider+account)", async () => {
    render(<LoginMethodsManager initialMethods={methods} hasMagicLink disconnect={disconnect} />);
    fireEvent.click(screen.getAllByRole("button", { name: /disconnect/i })[0]!);

    await waitFor(() => expect(disconnect).toHaveBeenCalledWith("google", "g-1"));
    await waitFor(() => expect(screen.queryByText("Google")).toBeNull());
    expect(screen.getByText("GitHub")).toBeInTheDocument(); // the other one stays
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

  it("guides how to connect a new provider (auto-link on sign-in, no fragile OAuth-link flow)", () => {
    render(<LoginMethodsManager initialMethods={[]} hasMagicLink disconnect={disconnect} />);
    expect(screen.getByText(/sign back in with that provider/i)).toBeInTheDocument();
    expect(screen.getByText(/no social logins are linked/i)).toBeInTheDocument();
  });
});
