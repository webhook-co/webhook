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

// Under OAUTH_MODE=optional a provider with no credentials is not wired into Better Auth at all, so its
// button must not render — clicking it would post to a provider the server has never heard of. The server
// decides (configuredSocialProviders) and passes the answer down; the default is both, which is production.
describe("LoginForm — social buttons follow what the server configured", () => {
  it("renders both provider buttons by default (the production shape)", () => {
    render(<LoginForm actions={makeActions()} Captcha={AutoCaptcha} />);
    expect(screen.getByRole("button", { name: /continue with google/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue with github/i })).toBeInTheDocument();
  });

  it("hides the Google button when Google is not configured", () => {
    render(
      <LoginForm
        actions={makeActions()}
        Captcha={AutoCaptcha}
        providers={{ google: false, github: true }}
      />,
    );
    expect(screen.queryByRole("button", { name: /continue with google/i })).toBeNull();
    expect(screen.getByRole("button", { name: /continue with github/i })).toBeInTheDocument();
  });

  it("hides the GitHub button when GitHub is not configured", () => {
    render(
      <LoginForm
        actions={makeActions()}
        Captcha={AutoCaptcha}
        providers={{ google: true, github: false }}
      />,
    );
    expect(screen.queryByRole("button", { name: /continue with github/i })).toBeNull();
    expect(screen.getByRole("button", { name: /continue with google/i })).toBeInTheDocument();
  });

  // With neither provider, magic link is the only way in — the email field and its submit must survive,
  // otherwise hiding the buttons would have removed the last route to a session.
  it("keeps the magic-link form when no provider is configured", () => {
    render(
      <LoginForm
        actions={makeActions()}
        Captcha={AutoCaptcha}
        providers={{ google: false, github: false }}
      />,
    );
    expect(screen.queryByRole("button", { name: /continue with google/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /continue with github/i })).toBeNull();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
  });

  it("drops the 'magic link' divider when it would separate nothing", () => {
    render(
      <LoginForm
        actions={makeActions()}
        Captcha={AutoCaptcha}
        providers={{ google: false, github: false }}
      />,
    );
    expect(screen.queryByText(/^magic link$/i)).toBeNull();
  });
});

describe("LoginForm", () => {
  it("renders the OAuth options, the magic-link form, and a disabled SSO option", () => {
    renderForm(makeActions());
    expect(screen.getByRole("button", { name: /continue with google/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue with github/i })).toBeInTheDocument();
    expect(screen.getByLabelText("Work email")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /send magic link/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /single sign-on/i })).toBeDisabled();
  });

  it("has no dead self-referential signup link (signup == login)", () => {
    renderForm(makeActions());
    // signup and login are one passwordless flow, so there's no separate "Sign up → /login" link
    expect(screen.queryByRole("link", { name: /sign up/i })).not.toBeInTheDocument();
    // a link-free note clarifies that signing in creates the account
    expect(screen.getByText(/signing in creates/i)).toBeInTheDocument();
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
    // It now NAMES that wait rather than sitting there greyed out and unexplained, which read as broken.
    expect(screen.getByRole("button", { name: /verifying you're human/i })).toBeDisabled();
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
    // The token was consumed by the attempt → submit is gated again (and says so) and a fresh (unsolved)
    // captcha is remounted so the user can re-solve for a new token.
    expect(screen.getByRole("button", { name: /verifying you're human/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /solve captcha/i })).toBeInTheDocument();
  });

  it("invokes continueWith for an OAuth provider (no captcha required for social)", async () => {
    const actions = makeActions();
    renderForm(actions);
    await userEvent.click(screen.getByRole("button", { name: /continue with github/i }));
    expect(actions.continueWith).toHaveBeenCalledWith("github");
  });

  // THE BUG THE FOUNDER REPORTED: "I click Sign in with Google and the UI doesn't change at all."
  //
  // `signIn.social` resolves as soon as it has handed the browser off to its navigation — BEFORE the browser
  // has actually left. The old code reset `pending` in a `finally`, so it fired immediately: the buttons
  // re-enabled, the spinner vanished, and the form snapped back to looking completely idle while the browser
  // was still loading Google. The user saw a flicker and then nothing, and reasonably concluded it was broken.
  //
  // The test that used to live here ASSERTED THAT BEHAVIOUR — "re-enables the form after a non-redirecting
  // (mock) OAuth attempt" — and so was actively protecting the bug. It only looked right because the MOCK does
  // not navigate; the non-navigation is a property of the test double, not a requirement of the product.
  it("stays busy after a successful OAuth start — the browser is still navigating", async () => {
    const actions = makeActions();
    renderForm(actions);

    await userEvent.click(screen.getByRole("button", { name: /continue with github/i }));

    const github = screen.getByRole("button", { name: /continue with github/i });
    expect(github).toHaveAttribute("aria-busy", "true");
    expect(github).toBeDisabled();
    // And every other control stays locked — a second click during the redirect starts a second OAuth flow.
    expect(screen.getByRole("button", { name: /continue with google/i })).toBeDisabled();
    expect(screen.getByLabelText("Work email")).toBeDisabled();
  });

  // The one case that MUST clear it: if starting the flow fails, the browser is going nowhere, and a form left
  // spinning forever would be a worse dead end than the one we just fixed.
  it("recovers the form when the OAuth start fails", async () => {
    const actions = makeActions({ continueWith: vi.fn().mockRejectedValue(new Error("nope")) });
    renderForm(actions);

    await userEvent.click(screen.getByRole("button", { name: /continue with github/i }));

    expect(await screen.findByText(/that didn't work/i)).toBeInTheDocument();
    const github = screen.getByRole("button", { name: /continue with github/i });
    expect(github).not.toHaveAttribute("aria-busy");
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

// The captcha wait. Turnstile takes a beat to solve on load, and until it does the submit button is disabled.
// Unexplained, that reads as a permanently broken control: the user pokes at it and blames us. So the button
// now says which wait it is in.
describe("LoginForm — the waits are named", () => {
  it("says it is verifying while the captcha is still solving", () => {
    render(<LoginForm actions={makeActions()} Captcha={ManualCaptcha} />);

    const submit = screen.getByRole("button", { name: /verifying you're human/i });
    expect(submit).toBeDisabled();
    expect(submit).toHaveAttribute("aria-busy", "true");
  });

  it("becomes a real submit button once the captcha resolves", async () => {
    render(<LoginForm actions={makeActions()} Captcha={ManualCaptcha} />);

    await userEvent.click(screen.getByRole("button", { name: /solve captcha/i }));

    const submit = await screen.findByRole("button", { name: /send magic link/i });
    expect(submit).toBeEnabled();
    expect(submit).not.toHaveAttribute("aria-busy");
  });

  it("shows the send in flight, and does not let it be double-submitted", async () => {
    let release!: () => void;
    const sendMagicLink = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    render(<LoginForm actions={makeActions({ sendMagicLink })} Captcha={AutoCaptcha} />);

    await userEvent.type(screen.getByLabelText("Work email"), "dana@acme.co");
    await userEvent.click(await screen.findByRole("button", { name: /send magic link/i }));

    const sending = screen.getByRole("button", { name: /sending/i });
    expect(sending).toHaveAttribute("aria-busy", "true");
    expect(sending).toBeDisabled();

    // A second click must not fire a second email.
    await userEvent.click(sending);
    expect(sendMagicLink).toHaveBeenCalledOnce();

    release();
    expect(await screen.findByText(/check your email/i)).toBeInTheDocument();
  });
});
