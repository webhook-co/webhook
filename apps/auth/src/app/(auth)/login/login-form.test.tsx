import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { LoginForm, type AuthActions } from "./login-form";

function makeActions(over: Partial<AuthActions> = {}): AuthActions {
  return {
    sendMagicLink: vi.fn().mockResolvedValue(undefined),
    continueWith: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

describe("LoginForm", () => {
  it("renders the OAuth options, the magic-link form, and a disabled SSO option", () => {
    render(<LoginForm actions={makeActions()} />);
    expect(screen.getByRole("button", { name: /continue with google/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue with github/i })).toBeInTheDocument();
    expect(screen.getByLabelText("Work email")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /send magic link/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /single sign-on/i })).toBeDisabled();
  });

  it("rejects an invalid email without calling the action", async () => {
    const actions = makeActions();
    render(<LoginForm actions={actions} />);
    await userEvent.type(screen.getByLabelText("Work email"), "not-an-email");
    await userEvent.click(screen.getByRole("button", { name: /send magic link/i }));
    expect(actions.sendMagicLink).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/valid email/i);
  });

  it("sends a magic link for a valid email and shows the sent confirmation", async () => {
    const actions = makeActions();
    render(<LoginForm actions={actions} />);
    await userEvent.type(screen.getByLabelText("Work email"), "dana@acme.co");
    await userEvent.click(screen.getByRole("button", { name: /send magic link/i }));
    expect(actions.sendMagicLink).toHaveBeenCalledWith("dana@acme.co");
    // the confirmation is a live region so it's announced after submit
    expect(await screen.findByRole("status")).toHaveTextContent(/check your email/i);
    expect(screen.getByText("dana@acme.co")).toBeInTheDocument();
  });

  it("surfaces an error when sending the magic link fails", async () => {
    const actions = makeActions({ sendMagicLink: vi.fn().mockRejectedValue(new Error("boom")) });
    render(<LoginForm actions={actions} />);
    await userEvent.type(screen.getByLabelText("Work email"), "dana@acme.co");
    await userEvent.click(screen.getByRole("button", { name: /send magic link/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't send/i);
  });

  it("invokes continueWith for an OAuth provider", async () => {
    const actions = makeActions();
    render(<LoginForm actions={actions} />);
    await userEvent.click(screen.getByRole("button", { name: /continue with github/i }));
    expect(actions.continueWith).toHaveBeenCalledWith("github");
  });

  it("re-enables the form after a non-redirecting (mock) OAuth attempt", async () => {
    const actions = makeActions();
    render(<LoginForm actions={actions} />);
    await userEvent.click(screen.getByRole("button", { name: /continue with github/i }));
    // the mock resolves without navigating away, so the form must not stay stuck-disabled
    expect(await screen.findByRole("button", { name: /send magic link/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /continue with google/i })).toBeEnabled();
  });

  it("can return from the sent state to try a different email", async () => {
    const actions = makeActions();
    render(<LoginForm actions={actions} />);
    await userEvent.type(screen.getByLabelText("Work email"), "dana@acme.co");
    await userEvent.click(screen.getByRole("button", { name: /send magic link/i }));
    await userEvent.click(await screen.findByRole("button", { name: /different email/i }));
    expect(screen.getByLabelText("Work email")).toBeInTheDocument();
  });
});
