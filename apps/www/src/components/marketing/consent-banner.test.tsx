import { FIRST_TOUCH_COOKIE } from "@webhook-co/shared/first-touch-cookie";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CONSENT_COOKIE } from "@/lib/consent";
import { ConsentBanner } from "./consent-banner";

// The client consent banner: shows once, when no choice has been recorded; Accept records consent (and
// promotes the current URL's utm to first-touch); Reject records the denial. The pure cookie decisions live
// in @/lib/consent (tested there) — this suite pins the component's behaviour: appears/hides on the right
// condition and writes the right cookies. A controllable document.cookie jar stands in for the browser
// store (jsdom rejects Secure cookies over http, so we intercept writes directly).

let jar: Record<string, string>;

beforeEach(() => {
  jar = {};
  Object.defineProperty(document, "cookie", {
    configurable: true,
    get: () =>
      Object.entries(jar)
        .map(([k, v]) => `${k}=${v}`)
        .join("; "),
    set: (raw: string) => {
      const first = String(raw).split(";")[0];
      const eq = first.indexOf("=");
      const name = first.slice(0, eq).trim();
      const value = first.slice(eq + 1);
      if (/;\s*max-age=0\b/i.test(String(raw))) {
        delete jar[name];
        return;
      }
      jar[name] = value;
    },
  });
  window.history.replaceState({}, "", "/");
});

afterEach(() => {
  delete (document as unknown as { cookie?: unknown }).cookie;
});

describe("ConsentBanner", () => {
  it("shows the banner with Accept + Reject + a privacy link when no choice has been made", async () => {
    render(<ConsentBanner />);
    expect(await screen.findByRole("button", { name: /accept/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reject/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /privacy/i })).toHaveAttribute(
      "href",
      "/privacy#cookies",
    );
  });

  it("stays hidden once a decision has already been recorded", () => {
    jar[CONSENT_COOKIE] = "granted";
    render(<ConsentBanner />);
    expect(screen.queryByRole("button", { name: /accept/i })).toBeNull();
  });

  it("on Accept records consent, promotes the URL's utm to first-touch, and hides", async () => {
    window.history.replaceState({}, "", "/pricing?utm_source=twitter&utm_medium=social");
    render(<ConsentBanner />);
    await userEvent.click(await screen.findByRole("button", { name: /accept/i }));
    expect(document.cookie).toContain(`${CONSENT_COOKIE}=granted`);
    expect(document.cookie).toContain(`${FIRST_TOUCH_COOKIE}=`);
    expect(document.cookie).toContain("s=twitter");
    await waitFor(() => expect(screen.queryByRole("button", { name: /accept/i })).toBeNull());
  });

  it("on Accept with no utm records consent but sets no first-touch", async () => {
    render(<ConsentBanner />);
    await userEvent.click(await screen.findByRole("button", { name: /accept/i }));
    expect(document.cookie).toContain(`${CONSENT_COOKIE}=granted`);
    expect(document.cookie).not.toContain(FIRST_TOUCH_COOKIE);
  });

  it("on Reject records the denial and hides", async () => {
    render(<ConsentBanner />);
    await userEvent.click(await screen.findByRole("button", { name: /reject/i }));
    expect(document.cookie).toContain(`${CONSENT_COOKIE}=denied`);
    await waitFor(() => expect(screen.queryByRole("button", { name: /reject/i })).toBeNull());
  });
});
