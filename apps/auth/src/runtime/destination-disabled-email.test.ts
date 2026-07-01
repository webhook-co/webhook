import { describe, expect, it } from "vitest";

import {
  renderDestinationDisabledEmail,
  type DestinationDisabledContext,
} from "./destination-disabled-email";

const BASE: DestinationDisabledContext = {
  destinationUrl: "https://api.acme.com/webhooks/inbound",
  failureCount: 20,
  lastError: "Bad Gateway",
  lastStatusCode: 502,
};
const PAUSED = new Date("2026-07-01T14:32:00Z");

describe("renderDestinationDisabledEmail", () => {
  it("renders the subject, destination, reason, error and paused time into both html and text", () => {
    const { subject, html, text } = renderDestinationDisabledEmail(BASE, PAUSED);
    expect(subject).toBe("A delivery destination was paused");
    for (const body of [html, text]) {
      expect(body).toContain("https://api.acme.com/webhooks/inbound");
      expect(body).toContain("20 consecutive failed deliveries");
      expect(body).toContain("HTTP 502");
      expect(body).toContain("Bad Gateway");
      expect(body).toContain("Jul 1, 2026 at 14:32 UTC");
      expect(body).toContain("https://app.webhook.co/destinations");
    }
    // the brand logo is the only remote asset, on our own domain
    expect(html).toContain("https://www.webhook.co/logo.png");
  });

  it("HTML-escapes a user-influenced destination URL + error so they can't inject markup", () => {
    const evil: DestinationDisabledContext = {
      destinationUrl: 'https://x.com/"><script>alert(1)</script>',
      failureCount: 20,
      lastError: "<img src=x onerror=alert(2)>",
      lastStatusCode: null,
    };
    const { html } = renderDestinationDisabledEmail(evil, PAUSED);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<img src=x onerror=alert(2)>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(2)&gt;");
  });

  it("formats a bare status code with no message, and a bare message with no code", () => {
    const codeOnly = renderDestinationDisabledEmail(
      { ...BASE, lastError: null, lastStatusCode: 500 },
      PAUSED,
    );
    expect(codeOnly.text).toContain("Last error:   HTTP 500");
    const msgOnly = renderDestinationDisabledEmail(
      { ...BASE, lastError: "Connection timed out", lastStatusCode: null },
      PAUSED,
    );
    expect(msgOnly.text).toContain("Last error:   Connection timed out");
    expect(msgOnly.text).not.toContain("HTTP");
  });

  it("omits the Last error line entirely when there is no error or code", () => {
    const { html, text } = renderDestinationDisabledEmail(
      { ...BASE, lastError: null, lastStatusCode: null },
      PAUSED,
    );
    expect(text).not.toContain("Last error");
    expect(html).not.toContain("Last error");
  });

  it("degrades gracefully for a null context (still a valid email, no Destination/Reason rows)", () => {
    const { subject, html, text } = renderDestinationDisabledEmail(null, PAUSED);
    expect(subject).toBe("A delivery destination was paused");
    for (const body of [html, text]) {
      expect(body).toContain("Jul 1, 2026 at 14:32 UTC"); // paused time still shown
      expect(body).toContain("https://app.webhook.co/destinations"); // CTA still present
    }
    expect(text).not.toContain("Destination:");
    expect(text).not.toContain("Reason:");
    expect(text).not.toContain("Last error:");
  });

  it("formats a midnight UTC time as 00:xx (manual UTC formatter, no Intl hour12 quirk)", () => {
    const { text } = renderDestinationDisabledEmail(BASE, new Date("2026-07-01T00:32:00Z"));
    expect(text).toContain("Jul 1, 2026 at 00:32 UTC");
    expect(text).not.toContain("24:32");
  });
});
