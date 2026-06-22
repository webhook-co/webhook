import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import { LoginForm, type AuthActions, type CaptchaWidgetProps } from "./login-form";

function makeActions(over: Partial<AuthActions> = {}): AuthActions {
  return {
    sendMagicLink: vi.fn().mockResolvedValue(undefined),
    continueWith: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

// The real Turnstile widget loads Cloudflare's script + an iframe (a human-eyeball concern), so tests
// inject a fake captcha through the same seam the form uses for `actions`. AutoCaptcha auto-solves on
// mount so the submit-flow tests have a token; ManualCaptcha solves only on click (the gating test).
function AutoCaptcha({ onToken }: CaptchaWidgetProps) {
  React.useEffect(() => {
    onToken("test-captcha-token");
  }, [onToken]);
  return <div data-testid="captcha" />;
}
function ManualCaptcha({ onToken }: CaptchaWidgetProps) {
  return (
    <button type="button" onClick={() => onToken("manual-token")}>
      solve captcha
    </button>
  );
}
function renderForm(
  actions: AuthActions,
  Captcha: React.ComponentType<CaptchaWidgetProps> = AutoCaptcha,
) {
  return render(<LoginForm actions={actions} Captcha={Captcha} />);
}

describe("LoginForm", () => {
  it("renders the OAuth options, the magic-link form, and a disabled SSO option", () => {
    renderForm(makeActions());
    expect(screen.getByRole("button", { name: /continue with google/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue with github/i })).toBeInTheDocument();
    expect(screen.getByLabelText("Work email")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /send magic link/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /single sign-on/i })).toBeDisabled();
  });

  it("rejects an invalid email without calling the action", async () => {
    const actions = makeActions();
    renderForm(actions);
    await userEvent.type(screen.getByLabelText("Work email"), "not-an-email");
    await userEvent.click(screen.getByRole("button", { name: /send magic link/i }));
    expect(actions.sendMagicLink).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/valid email/i);
  });

  it("sends a magic link (with the captcha token) for a valid email and shows the confirmation", async () => {
    const actions = makeActions();
    renderForm(actions);
    await userEvent.type(screen.getByLabelText("Work email"), "dana@acme.co");
    await userEvent.click(screen.getByRole("button", { name: /send magic link/i }));
    expect(actions.sendMagicLink).toHaveBeenCalledWith("dana@acme.co", "test-captcha-token");
    // the confirmation is a live region so it's announced after submit
    expect(await screen.findByRole("status")).toHaveTextContent(/check your email/i);
    expect(screen.getByText("dana@acme.co")).toBeInTheDocument();
  });

  it("keeps the magic-link submit disabled until the captcha is solved", async () => {
    const actions = makeActions();
    renderForm(actions, ManualCaptcha);
    await userEvent.type(screen.getByLabelText("Work email"), "dana@acme.co");
    // Unsolved captcha → the send button is disabled (a POST without a token would be rejected server-side).
    expect(screen.getByRole("button", { name: /send magic link/i })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: /solve captcha/i }));
    expect(screen.getByRole("button", { name: /send magic link/i })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: /send magic link/i }));
    expect(actions.sendMagicLink).toHaveBeenCalledWith("dana@acme.co", "manual-token");
  });

  it("surfaces an error when sending the magic link fails", async () => {
    const actions = makeActions({ sendMagicLink: vi.fn().mockRejectedValue(new Error("boom")) });
    renderForm(actions);
    await userEvent.type(screen.getByLabelText("Work email"), "dana@acme.co");
    await userEvent.click(screen.getByRole("button", { name: /send magic link/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't send/i);
  });

  it("drops the (single-use) captcha token and re-gates submit after a failed send", async () => {
    const actions = makeActions({ sendMagicLink: vi.fn().mockRejectedValue(new Error("boom")) });
    renderForm(actions, ManualCaptcha);
    await userEvent.type(screen.getByLabelText("Work email"), "dana@acme.co");
    await userEvent.click(screen.getByRole("button", { name: /solve captcha/i }));
    await userEvent.click(screen.getByRole("button", { name: /send magic link/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't send/i);
    // The token was consumed by the attempt → submit is disabled again and a fresh (unsolved) captcha is
    // remounted so the user can re-solve for a new token.
    expect(screen.getByRole("button", { name: /send magic link/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /solve captcha/i })).toBeInTheDocument();
  });

  it("invokes continueWith for an OAuth provider (no captcha required for social)", async () => {
    const actions = makeActions();
    renderForm(actions);
    await userEvent.click(screen.getByRole("button", { name: /continue with github/i }));
    expect(actions.continueWith).toHaveBeenCalledWith("github");
  });

  it("re-enables the form after a non-redirecting (mock) OAuth attempt", async () => {
    const actions = makeActions();
    renderForm(actions);
    await userEvent.click(screen.getByRole("button", { name: /continue with github/i }));
    // the mock resolves without navigating away, so the form must not stay stuck-disabled
    expect(await screen.findByRole("button", { name: /send magic link/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /continue with google/i })).toBeEnabled();
  });

  it("can return from the sent state to try a different email", async () => {
    const actions = makeActions();
    renderForm(actions);
    await userEvent.type(screen.getByLabelText("Work email"), "dana@acme.co");
    await userEvent.click(screen.getByRole("button", { name: /send magic link/i }));
    await userEvent.click(await screen.findByRole("button", { name: /different email/i }));
    expect(screen.getByLabelText("Work email")).toBeInTheDocument();
  });
});
