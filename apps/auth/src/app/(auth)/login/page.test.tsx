import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import LoginPage from "./page";

vi.mock("./login-actions", () => ({ LoginActions: () => <div /> }));

// The page now reads the IdP session so it can RESUME an already-signed-in user instead of asking them to
// sign in again. Default to signed-OUT here, so these render assertions exercise the form as before.
const isSignedIn = vi.fn(async () => false);
vi.mock("./resolve-signed-in", () => ({ isSignedIn: () => isSignedIn() }));
vi.mock("next/navigation", () => ({
  // The real redirect() throws to halt rendering; mirror that so a bounce can't fall through to the form.
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

// jsdom doesn't implement matchMedia, and the shell's ThemeToggle reads it on mount. Same stub the
// sibling turnstile test uses (and apps/web's setup file). Default to light.
beforeEach(() => {
  // Reset between tests: the loop-breaker tests deliberately queue a signed-IN value that is never consumed
  // (the whole point is that the page doesn't ask), and a leftover `Once` would bleed into the next test.
  isSignedIn.mockReset();
  isSignedIn.mockResolvedValue(false);
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});

/**
 * The sign-in page used to publish three invented figures — "99.99% delivery SLA", "38ms median
 * latency", "3.4M events / day". None were measured; none were true.
 *
 * The SLA one was the worst: our own Terms of Service say the Service is provided "on a best-effort
 * basis with no guaranteed uptime or service-level commitment". So the login page was promising a
 * 99.99% SLA that the contract a user agrees to on that very page explicitly disclaims. That isn't
 * marketing puff — it's the product contradicting its own terms on the same screen.
 */
describe("LoginPage", () => {
  it("publishes no invented performance figures", async () => {
    const { container } = render(await LoginPage({}));
    const text = container.textContent ?? "";

    for (const claim of [
      "99.99%",
      "delivery SLA",
      "38ms",
      "median latency",
      "3.4M",
      "events / day",
    ]) {
      expect(text, `the login page still claims "${claim}"`).not.toContain(claim);
    }
  });

  // A number next to a unit is how a fabricated stat gets back in. There is nothing on this page we
  // actually measure, so there should be no measurement on it.
  it("shows no uptime, latency or volume metric at all", async () => {
    const { container } = render(await LoginPage({}));
    const text = container.textContent ?? "";

    expect(text).not.toMatch(/\d+(\.\d+)?\s*%/); // 99.99%
    expect(text).not.toMatch(/\d+\s*ms\b/i); // 38ms
    expect(text).not.toMatch(/\d+(\.\d+)?[MKB]\b/); // 3.4M
    expect(text).not.toMatch(/\bSLA\b/i);
  });

  it("still says what the product is, and still links the legal terms", async () => {
    render(await LoginPage({}));
    expect(screen.getByText(/durable delivery/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /terms of service/i })).toHaveAttribute(
      "href",
      "https://www.webhook.co/terms",
    );
    expect(screen.getByRole("link", { name: /privacy policy/i })).toHaveAttribute(
      "href",
      "https://www.webhook.co/privacy",
    );
  });
});

/**
 * Signing in once should keep you signed in.
 *
 * The page never read the session, so an already-authenticated user — someone who pressed Back, opened a
 * fresh tab, or whose app. cookie had expired while the IdP session was still perfectly valid — was shown the
 * sign-in form and made to authenticate again. Single sign-on that asks you to sign in twice isn't single
 * sign-on. Now a live IdP session resumes straight into the product.
 */
describe("LoginPage — resuming an existing session", () => {
  it("bounces an already-signed-in user into the handoff instead of asking again", async () => {
    isSignedIn.mockResolvedValueOnce(true);
    await expect(LoginPage({})).rejects.toThrow("NEXT_REDIRECT:/session/handoff");
  });

  it("honours a safe ?redirect= target when resuming", async () => {
    isSignedIn.mockResolvedValueOnce(true);
    await expect(
      LoginPage({ searchParams: Promise.resolve({ redirect: "/consent?x=1" }) }),
    ).rejects.toThrow("NEXT_REDIRECT:/consent?x=1");
  });

  it("refuses an off-origin ?redirect= and resumes to the handoff (no open redirect)", async () => {
    isSignedIn.mockResolvedValueOnce(true);
    await expect(
      LoginPage({ searchParams: Promise.resolve({ redirect: "//evil.example/pwn" }) }),
    ).rejects.toThrow("NEXT_REDIRECT:/session/handoff");
  });

  // THE LOOP BREAKER. app.'s callback redirects here with ?error= when it could not redeem the handoff
  // ticket. Without this guard the page would see the still-live IdP session, bounce back to
  // /session/handoff, mint another ticket, fail to redeem it again — forever, locking the user out entirely.
  it("does NOT bounce after a failed handoff — it shows the form", async () => {
    isSignedIn.mockResolvedValueOnce(true);
    const { container } = render(
      await LoginPage({ searchParams: Promise.resolve({ error: "handoff_failed" }) }),
    );
    // It rendered the page rather than throwing a redirect — the sign-in surface (its legal footer is the
    // page's own markup; the form itself is the mocked LoginActions).
    expect(container.textContent).toContain("Terms of Service");
  });

  it("does not even ASK the IdP when the handoff just failed", async () => {
    isSignedIn.mockClear();
    render(await LoginPage({ searchParams: Promise.resolve({ error: "handoff_failed" }) }));
    expect(isSignedIn).not.toHaveBeenCalled();
  });

  it("renders the form for a signed-out visitor", async () => {
    isSignedIn.mockResolvedValueOnce(false);
    const { container } = render(await LoginPage({}));
    expect(container.textContent).toContain("Terms of Service");
  });
});
