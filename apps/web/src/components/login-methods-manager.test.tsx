import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LoginMethod } from "@webhook-co/contract";

import { LoginMethodsManager } from "./login-methods-manager";

const disconnect = vi.fn();

/** The provider label of each row, in render order — the row's IDENTITY, without its state or date. */
const rowLabels = () =>
  screen.getAllByRole("listitem").map((li) => li.querySelector("span span")?.textContent);

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
    // "sign out and" is load-bearing, not filler: /login bounces an already-signed-in user to
    // /session/handoff, so "sign in with GitHub" attempted from THIS page silently returns you to the
    // dashboard and reads as broken. Dropping those two words turns a procedure into a dead end.
    expect(
      screen.getByText(/sign out and sign back in with Google using this email/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/sign out and sign back in with GitHub using this email/i),
    ).toBeInTheDocument();
  });

  it("renders EVERY linked account — a second row for one provider must never be swallowed", () => {
    // listLoginMethods returns every `account` row with NO provider filter, and a user CAN hold two of the
    // same provider (link google:a@x, change email to b@y, sign in with a second Google verified at b@y →
    // the pinned auto-link writes a second google row; the (providerId, accountId) unique index doesn't stop
    // that). Rendering "one row per offered provider + find()" kept the newest and silently dropped the
    // older — leaving a fully working sign-in path with no control able to remove it, on the page whose one
    // job is to enumerate exactly those.
    const two: LoginMethod[] = [
      { providerId: "google", accountId: "g-1", linkedAt: 1_700_000_000 },
      { providerId: "google", accountId: "g-2", linkedAt: 1_700_200_000 },
    ];
    render(<LoginMethodsManager initialMethods={two} hasMagicLink disconnect={disconnect} />);
    expect(screen.getAllByText("Google")).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: /disconnect/i })).toHaveLength(2);
  });

  it("keeps every provider in a FIXED slot — a row must never move when you disconnect it", async () => {
    // The row you just acted on jumping position under your cursor is the bug: whatever Disconnect lands
    // where your pointer already is belongs to an account you did NOT touch, one click away from removing the
    // wrong way into your account. `rows()` appending placeholders last made the slot depend on link state, so
    // disconnecting Google re-rendered the list as GitHub, Google. Slots follow OFFERED order, always.
    render(<LoginMethodsManager initialMethods={methods} hasMagicLink disconnect={disconnect} />);
    expect(rowLabels()).toEqual(["Google", "GitHub"]);

    fireEvent.click(screen.getAllByRole("button", { name: /disconnect/i })[0]!);
    await waitFor(() => expect(disconnect).toHaveBeenCalledWith("google", "g-1"));
    // Google is now a placeholder, but it is STILL first.
    await waitFor(() => expect(rowLabels()).toEqual(["Google", "GitHub"]));
  });

  it("keeps providers in OFFERED order even when one holds TWO accounts", async () => {
    // The case the fixed-slot claim was written for and never covered. Both Googles sit in Google's slot,
    // above GitHub; disconnecting one leaves the other in place and GitHub still last. Rows below a removed
    // row DO shift up — a list got shorter — but no provider may overtake another.
    const three: LoginMethod[] = [
      { providerId: "google", accountId: "g-1", linkedAt: 1_700_000_000 },
      { providerId: "google", accountId: "g-2", linkedAt: 1_700_000_100 },
      { providerId: "github", accountId: "gh-1", linkedAt: 1_700_100_000 },
    ];
    render(<LoginMethodsManager initialMethods={three} hasMagicLink disconnect={disconnect} />);
    expect(rowLabels()).toEqual(["Google", "Google", "GitHub"]);

    fireEvent.click(screen.getByRole("button", { name: "Disconnect Google (g-2)" }));
    await waitFor(() => expect(disconnect).toHaveBeenCalledWith("google", "g-2"));
    await waitFor(() => expect(rowLabels()).toEqual(["Google", "GitHub"]));
    // The surviving Google keeps its slot above GitHub, and sheds the now-pointless discriminator.
    expect(screen.queryByText(/g-1/)).toBeNull();
  });

  it("puts a GitHub-only user's rows in OFFERED order too — link state must not reorder", () => {
    render(
      <LoginMethodsManager initialMethods={[methods[1]!]} hasMagicLink disconnect={disconnect} />,
    );
    expect(rowLabels()).toEqual(["Google", "GitHub"]); // NOT GitHub-first because it happens to be linked
  });

  it("makes two accounts of the SAME provider tellable apart — by sight and to a screen reader", async () => {
    // Both rows rendering is the fix; both rows being IDENTICAL is the new bug. Label is "Google" twice and
    // fmtDate slices to a day, so a same-day pair is byte-identical — and the only accessible name on either
    // button is "Disconnect". Dana can't tell which Google she's removing and may drop the one she uses,
    // leaving the stale one: the exact inverse of why she opened the page. accountId is the ONLY discriminator
    // LoginMethod carries, so it has to surface — but only when it's actually needed to disambiguate.
    const two: LoginMethod[] = [
      { providerId: "google", accountId: "g-1", linkedAt: 1_700_000_000 },
      { providerId: "google", accountId: "g-2", linkedAt: 1_700_000_100 }, // same DAY on purpose
    ];
    render(<LoginMethodsManager initialMethods={two} hasMagicLink disconnect={disconnect} />);

    expect(screen.getByText(/g-1/)).toBeInTheDocument();
    expect(screen.getByText(/g-2/)).toBeInTheDocument();
    // The button a screen reader announces must say WHICH account it removes.
    const first = screen.getByRole("button", { name: "Disconnect Google (g-1)" });
    expect(screen.getByRole("button", { name: "Disconnect Google (g-2)" })).toBeInTheDocument();
    fireEvent.click(first);
    await waitFor(() => expect(disconnect).toHaveBeenCalledWith("google", "g-1"));
  });

  it("does NOT show the opaque accountId when there's nothing to disambiguate", () => {
    // It's noise on the common path — one Google, one GitHub. It earns its place only when two rows collide.
    render(<LoginMethodsManager initialMethods={methods} hasMagicLink disconnect={disconnect} />);
    expect(screen.queryByText(/g-1/)).toBeNull();
    expect(screen.getByRole("button", { name: "Disconnect Google" })).toBeInTheDocument();
  });

  it("renders a linked provider we don't offer — it's still a way in", () => {
    // Anything added to the issuer later would otherwise stay invisible until someone edited the array.
    render(
      <LoginMethodsManager
        initialMethods={[{ providerId: "gitlab", accountId: "gl-1", linkedAt: 1_700_000_000 }]}
        hasMagicLink
        disconnect={disconnect}
      />,
    );
    expect(screen.getByText("gitlab")).toBeInTheDocument(); // raw id beats not showing it at all
    expect(screen.getByRole("button", { name: /disconnect/i })).toBeInTheDocument();
  });

  it("disconnect still targets the exact provider+accountId, not just the provider", async () => {
    const two: LoginMethod[] = [
      { providerId: "google", accountId: "g-1", linkedAt: 1_700_000_000 },
      { providerId: "google", accountId: "g-2", linkedAt: 1_700_200_000 },
    ];
    render(<LoginMethodsManager initialMethods={two} hasMagicLink disconnect={disconnect} />);
    fireEvent.click(screen.getAllByRole("button", { name: /disconnect/i })[1]!);
    await waitFor(() => expect(disconnect).toHaveBeenCalledWith("google", "g-2"));
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
