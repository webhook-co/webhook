import { describe, expect, it } from "vitest";

import {
  renderFreeOrgCapSuspendedEmail,
  renderFreeOrgCapWarningEmail,
  type EmailOrg,
} from "./free-org-cap-email";

const ORG: EmailOrg = { name: "Acme Inc", slug: "acme-inc" };
const WARN = { graceUntilIso: "2026-07-30T09:15:00Z", cap: 2 };
const SUSPEND = { restoreDeadlineIso: "2026-08-29T09:15:00Z", cap: 2 };

describe("renderFreeOrgCapWarningEmail", () => {
  it("names the org and states the suspend date in the subject, body, and text", () => {
    const e = renderFreeOrgCapWarningEmail(WARN, ORG);
    expect(e.subject).toBe("Heads up: Acme Inc will be suspended on Jul 30, 2026");
    expect(e.html).toContain("Acme Inc will be suspended on Jul 30, 2026");
    expect(e.text).toContain("Jul 30, 2026");
    // The rule is explained from the context's cap, never hardcoded.
    expect(e.html).toContain("up to 2 organizations");
  });

  it("says nothing has changed yet — the org is still fully active at warning time", () => {
    const e = renderFreeOrgCapWarningEmail(WARN, ORG);
    expect(e.text).toContain("Nothing has changed yet");
    // It must not claim anything is already paused/stopped/suspended-in-past-tense.
    expect(e.text).not.toContain("has been suspended");
    expect(e.text).not.toMatch(/we've stopped/i);
  });

  it("links the CTA at the org's billing page (the upgrade path out)", () => {
    const e = renderFreeOrgCapWarningEmail(WARN, ORG);
    expect(e.html).toContain("https://app.webhook.co/org/acme-inc/billing");
  });
});

describe("renderFreeOrgCapSuspendedEmail", () => {
  it("names the org and states what actually stopped", () => {
    const e = renderFreeOrgCapSuspendedEmail(SUSPEND, ORG);
    expect(e.subject).toBe("Acme Inc has been suspended");
    expect(e.text).toContain("stopped capturing new events");
    expect(e.text).toContain("delivery is on hold");
    expect(e.text).toContain("read-only");
  });

  it("promises retention as a FLOOR and never threatens deletion (nothing deletes a suspended org)", () => {
    const e = renderFreeOrgCapSuspendedEmail(SUSPEND, ORG);
    expect(e.text).toContain("Nothing has been deleted");
    expect(e.text).toContain("until at least Aug 29, 2026");
    // No code path deletes a suspended org, so the copy must not imply a deletion deadline.
    expect(e.text).not.toMatch(/will be deleted|permanently removed|deleted after|erased/i);
  });

  it("links the CTA at the org's suspended screen (where the restore CTA lives)", () => {
    const e = renderFreeOrgCapSuspendedEmail(SUSPEND, ORG);
    expect(e.html).toContain("https://app.webhook.co/org/acme-inc/suspended");
  });
});

describe("free-org-cap emails — the org name is user-controlled", () => {
  const EVIL: EmailOrg = { name: `<script>alert('x')</script>`, slug: "acme-inc" };

  it("escapes injected markup in the org name out of the HTML body", () => {
    for (const e of [
      renderFreeOrgCapWarningEmail(WARN, EVIL),
      renderFreeOrgCapSuspendedEmail(SUSPEND, EVIL),
    ]) {
      expect(e.html).not.toContain("<script>");
      expect(e.html).toContain("&lt;script&gt;");
    }
  });

  it("strips CR/LF from the subject (a subject is a header — escapeHtml passes newlines through)", () => {
    const injected: EmailOrg = { name: "Acme\r\nBcc: attacker@evil.test", slug: "acme-inc" };
    for (const e of [
      renderFreeOrgCapWarningEmail(WARN, injected),
      renderFreeOrgCapSuspendedEmail(SUSPEND, injected),
    ]) {
      expect(e.subject).not.toMatch(/[\r\n]/);
      expect(e.subject).toContain("Acme Bcc: attacker@evil.test");
    }
  });

  it("percent-encodes the slug into the CTA path rather than trusting it", () => {
    const traversal: EmailOrg = { name: "Acme", slug: "../../evil" };
    const e = renderFreeOrgCapSuspendedEmail(SUSPEND, traversal);
    expect(e.html).not.toContain("/org/../../evil/");
    expect(e.html).toContain("https://app.webhook.co/org/..%2F..%2Fevil/suspended");
  });
});

describe("free-org-cap emails — a malformed context degrades, never throws", () => {
  // A render throw is claimed-but-never-sent (notify-cron claims before rendering), i.e. a silently lost
  // notification. Every one of these must still produce a valid, sendable email.
  it("falls back to a neutral org name when the name is null or blank", () => {
    for (const org of [
      { name: null, slug: null },
      { name: "   ", slug: "acme-inc" },
    ] as EmailOrg[]) {
      const e = renderFreeOrgCapSuspendedEmail(SUSPEND, org);
      expect(e.subject).toBe("One of your organizations has been suspended");
    }
  });

  it("falls back to the dashboard root when the slug is missing", () => {
    const e = renderFreeOrgCapWarningEmail(WARN, { name: "Acme", slug: null });
    expect(e.html).toContain(`href="https://app.webhook.co"`);
  });

  it("drops the date rather than rendering 'Invalid Date' when the ISO is unparseable", () => {
    const e = renderFreeOrgCapWarningEmail({ graceUntilIso: "not-a-date", cap: 2 }, ORG);
    expect(e.subject).toBe("Heads up: Acme Inc will be suspended soon");
    expect(e.html).not.toContain("Invalid Date");
    expect(e.html).not.toContain("NaN");
  });

  it("drops the retention date rather than rendering a broken one", () => {
    const e = renderFreeOrgCapSuspendedEmail({ restoreDeadlineIso: "", cap: 2 }, ORG);
    expect(e.text).toContain("Nothing has been deleted, and nothing will be while it's suspended.");
    expect(e.html).not.toContain("Invalid Date");
  });

  it("describes the limit without a number when the cap is unusable", () => {
    for (const cap of [0, -1, 1.5, Number.NaN] as number[]) {
      const e = renderFreeOrgCapWarningEmail({ ...WARN, cap }, ORG);
      expect(e.html).toContain("a limited number of organizations");
      expect(e.html).not.toContain("up to");
      expect(e.html).not.toContain("NaN");
    }
  });
});
