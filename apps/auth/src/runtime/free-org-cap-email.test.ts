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
  it("names the org and states the suspend date — with its timezone — in the subject, body, and text", () => {
    const e = renderFreeOrgCapWarningEmail(WARN, ORG);
    expect(e.subject).toBe("Heads up: Acme Inc will be suspended on Jul 30, 2026 (UTC)");
    expect(e.html).toContain("Acme Inc will be suspended on Jul 30, 2026 (UTC)");
    expect(e.text).toContain("Jul 30, 2026 (UTC)");
    // The rule is explained from the context's cap, never hardcoded.
    expect(e.html).toContain("up to 2 free organizations per user");
  });

  it("says nothing has changed yet — the org is still fully active at warning time", () => {
    const e = renderFreeOrgCapWarningEmail(WARN, ORG);
    expect(e.text).toContain("Nothing has changed yet");
    // It must not claim anything is already paused/stopped/suspended-in-past-tense.
    expect(e.text).not.toContain("has been suspended");
    expect(e.text).not.toMatch(/we've stopped/i);
  });

  it("never claims this org is the ONLY one at risk — the reconciler flags every org past the cap", () => {
    // A paid→Free downgrade can leave N orgs over the cap, and each gets its own warning. A reader told
    // theirs is "the newest"/"the one" would fix that org and be blindsided when the rest suspend anyway.
    const e = renderFreeOrgCapWarningEmail(WARN, ORG);
    expect(e.text).not.toMatch(/newest|the one scheduled|only organization/i);
    expect(e.text).toContain("each one gets its own notice");
  });

  it("does not accuse the reader of being over the cap — every OWNER gets this, but the cap is per-user", () => {
    const e = renderFreeOrgCapWarningEmail(WARN, ORG);
    // A co-owner who is not themselves over the cap can neither verify nor act on "you're over the limit".
    expect(e.text).not.toMatch(/you're currently over|you are over|your newest/i);
    expect(e.text).toContain("per user");
  });

  it("labels the CTA for what it actually does — upgrade THIS org, which is where it links", () => {
    const e = renderFreeOrgCapWarningEmail(WARN, ORG);
    expect(e.html).toContain("https://app.webhook.co/org/acme-inc/billing");
    expect(e.html).toContain("Upgrade this organization");
    // "Review your organizations" (plural) promised an org list this button does not go to.
    expect(e.html).not.toMatch(/Review your organizations/i);
  });

  it("tolerates being stale — the intent can drain after the owner already resolved the overage", () => {
    const e = renderFreeOrgCapWarningEmail(WARN, ORG);
    expect(e.text).toMatch(/Already sorted it out\? Then ignore this/i);
  });
});

describe("renderFreeOrgCapSuspendedEmail", () => {
  it("names the org and states what actually stopped", () => {
    const e = renderFreeOrgCapSuspendedEmail(SUSPEND, ORG);
    expect(e.subject).toBe("Acme Inc has been suspended");
    expect(e.text).toContain("stopped capturing new events");
    expect(e.text).toContain("delivery is on hold");
  });

  it("describes the dashboard as gated, NOT read-only — every data page redirects to /suspended", () => {
    // requireActiveOrgAccess redirects all data/read pages; only settings + billing stay reachable. "Read-only"
    // would promise browsable-but-frozen data the owner cannot actually reach.
    const e = renderFreeOrgCapSuspendedEmail(SUSPEND, ORG);
    expect(e.text).not.toMatch(/read-only/i);
    expect(e.text).toContain("shows a suspension notice in place of your data");
    expect(e.text).toContain("Settings and billing stay open");
  });

  it("does NOT promise event retention — the free-plan prune ignores suspension entirely", () => {
    // retention.ts prunes on received_at with no orgs.status predicate, and webhook_retention's grant on orgs
    // is (id, retention_days) — it cannot even see suspension. A promise to keep events until the restore
    // deadline is falsified within a week on the free plan's 7-day retention.
    const e = renderFreeOrgCapSuspendedEmail(SUSPEND, ORG);
    expect(e.text).not.toMatch(/nothing has been deleted|keeping it all|until at least/i);
    expect(e.text).not.toMatch(/events.{0,40}(are all still there|untouched)/i);
    // What it says instead: config kept, events age out as usual, restore sooner to keep more.
    expect(e.text).toContain("keep aging out on the free plan's usual retention");
    expect(e.text).toContain("the sooner you restore it, the more history you keep");
    // The restore DEADLINE is about the org, not the data — and is still stated.
    expect(e.text).toContain("You have until Aug 29, 2026 (UTC) to restore it");
  });

  it("never threatens deletion of the org — no code path deletes a suspended org", () => {
    const e = renderFreeOrgCapSuspendedEmail(SUSPEND, ORG);
    expect(e.text).not.toMatch(/will be deleted|permanently removed|deleted after|erased/i);
  });

  it("links the CTA at the org's suspended screen (where the restore CTA lives)", () => {
    const e = renderFreeOrgCapSuspendedEmail(SUSPEND, ORG);
    expect(e.html).toContain("https://app.webhook.co/org/acme-inc/suspended");
  });

  it("tolerates being stale — the org may have been restored between enqueue and drain", () => {
    const e = renderFreeOrgCapSuspendedEmail(SUSPEND, ORG);
    expect(e.text).toMatch(/Already restored it\? Then ignore this/i);
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

  it("drops the restore deadline rather than rendering a broken one", () => {
    const e = renderFreeOrgCapSuspendedEmail({ restoreDeadlineIso: "", cap: 2 }, ORG);
    expect(e.text).not.toMatch(/You have until/);
    expect(e.text).toContain("keep aging out on the free plan's usual retention"); // still honest
    expect(e.html).not.toContain("Invalid Date");
  });

  it("describes the limit without a number when the cap is unusable", () => {
    for (const cap of [0, -1, 1.5, Number.NaN] as number[]) {
      const e = renderFreeOrgCapWarningEmail({ ...WARN, cap }, ORG);
      expect(e.html).toContain("a limited number of free organizations per user");
      expect(e.html).not.toContain("up to ");
      expect(e.html).not.toContain("NaN");
    }
  });
});
