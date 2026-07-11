import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import LoginPage from "./page";

vi.mock("./login-actions", () => ({ LoginActions: () => <div /> }));

// jsdom doesn't implement matchMedia, and the shell's ThemeToggle reads it on mount. Same stub the
// sibling turnstile test uses (and apps/web's setup file). Default to light.
beforeEach(() => {
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
  it("publishes no invented performance figures", () => {
    const { container } = render(<LoginPage />);
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
  it("shows no uptime, latency or volume metric at all", () => {
    const { container } = render(<LoginPage />);
    const text = container.textContent ?? "";

    expect(text).not.toMatch(/\d+(\.\d+)?\s*%/); // 99.99%
    expect(text).not.toMatch(/\d+\s*ms\b/i); // 38ms
    expect(text).not.toMatch(/\d+(\.\d+)?[MKB]\b/); // 3.4M
    expect(text).not.toMatch(/\bSLA\b/i);
  });

  it("still says what the product is, and still links the legal terms", () => {
    render(<LoginPage />);
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
