import { describe, expect, it } from "vitest";

import {
  renderFreeOrgCapSuspendedEmail,
  renderFreeOrgCapWarningEmail,
  type EmailOrg,
} from "./free-org-cap-email";

const ORG: EmailOrg = { name: "Acme Inc", slug: "acme-inc" };
const WARN = { graceUntilIso: "2026-07-30T09:15:00Z", cap: 2 };
const SUSPEND = { cap: 2 };

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

  describe('the "reminder" variant (slice 4b)', () => {
    it("reframes the opening and subject, and nothing else", () => {
      const initial = renderFreeOrgCapWarningEmail(WARN, ORG, "initial");
      const reminder = renderFreeOrgCapWarningEmail(WARN, ORG, "reminder");

      expect(reminder.subject).toBe(
        "Still scheduled: Acme Inc will be suspended on Jul 30, 2026 (UTC)",
      );
      expect(reminder.text).toContain("Acme Inc is still over the free plan's limit");
      // Same deadline, same remedy, same CTA — a reader who MISSED the first needs the whole message, not a
      // diff. That's the entire point: it's a redundant copy, not an escalation.
      expect(reminder.html).toContain("Jul 30, 2026 (UTC)");
      expect(reminder.html).toContain("Upgrade this organization");
      expect(reminder.html).toContain("https://app.webhook.co/org/acme-inc/billing");
      expect(reminder.text).toContain("each one gets its own notice");
      expect(reminder.text).toContain("Nothing has changed yet");
      // And it must not imply the deadline moved or that this is a new problem.
      expect(reminder.subject).not.toContain("Heads up");
      expect(initial.text).not.toContain("is still over the free plan's limit");
    });

    it("NEVER claims the earlier notice was delivered — this email exists because it may not have been", () => {
      // The drain marks an intent 'sent' BEFORE the Resend call, so 'sent' records an attempt, not a
      // delivery. "A follow-up on the notice we sent earlier" is therefore deterministically false for the
      // exact reader slice 4b was built for (a warning lost to a 5xx) — it sends them hunting their spam for
      // an email that does not exist, or reads as "you ignored us". It's also false for an owner ADDED during
      // the grace window, since recipients are re-resolved from current membership at drain time.
      const e = renderFreeOrgCapWarningEmail(WARN, ORG, "reminder");
      expect(e.text).not.toMatch(
        /we sent earlier|as we (told|said|mentioned)|follow-up on the notice/i,
      );
      expect(e.text).not.toMatch(/reminded you|our previous email|didn't hear back/i);
      // "still over" is true for every recipient regardless of what landed.
      expect(e.text).toContain("is still over the free plan's limit");
    });

    it("still degrades to a dateless notice when the context is unusable", () => {
      const e = renderFreeOrgCapWarningEmail(null, ORG, "reminder");
      expect(e.subject).toBe("Still scheduled: Acme Inc will be suspended soon");
      expect(e.html).not.toContain("Invalid Date");
    });
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
    // is (id, retention_days) — it cannot even see suspension. A promise to keep events "until <date>" is
    // falsified within a week on the free plan's 7-day retention.
    const e = renderFreeOrgCapSuspendedEmail(SUSPEND, ORG);
    expect(e.text).not.toMatch(/nothing has been deleted|keeping it all|until at least/i);
    expect(e.text).not.toMatch(/events.{0,40}(are all still there|untouched|preserved)/i);
    // What it says instead: config kept, events age out as usual, restore sooner to keep more.
    expect(e.text).toContain("keep aging out on the free plan's usual retention");
    expect(e.text).toContain("the sooner you restore it, the more history you keep");
  });

  it("states NO restore deadline — restoration never expires", () => {
    // restoreOrgFromFreeCap gates only on status + reason, and 0087 dropped the restore_deadline column
    // outright, so a cap-suspended org can be restored forever. A stated deadline is one an owner who missed
    // it reads as "too late, don't bother" — a fabricated loss. The copy simply doesn't raise the subject: it makes no
    // deadline claim in EITHER direction, since 0083 reserves the column for a future hard-delete slice and a
    // "there's no deadline" promise would have to be walked back the day that ships.
    const e = renderFreeOrgCapSuspendedEmail(SUSPEND, ORG);
    expect(e.text).not.toMatch(/you have until|expires|deadline|restore by/i);
    // The only time-pressure it states is the real one.
    expect(e.text).toContain("the sooner you restore it, the more history you keep");
  });

  it("never threatens deletion of the org — no code path deletes a suspended org", () => {
    const e = renderFreeOrgCapSuspendedEmail(SUSPEND, ORG);
    expect(e.text).not.toMatch(/will be deleted|permanently removed|deleted after|erased/i);
  });

  it("does not instruct a co-owner to delete an unrelated org — the cap is another user's count", () => {
    // Every OWNER gets this mail, but the cap is per-owner: nothing a co-owner deletes changes the over-cap
    // user's slice, so "delete a different one to free up a slot" costs them an org for no effect.
    const e = renderFreeOrgCapSuspendedEmail(SUSPEND, ORG);
    expect(e.text).not.toMatch(
      /delete or upgrade a different one|delete one you're no longer using/i,
    );
    expect(e.text).toContain("upgrade it to a paid plan"); // the remedy every recipient CAN act on
  });

  it("labels the CTA for what it actually does — /suspended has no restore control on it", () => {
    // The label promises a restore, so it must land somewhere that restores. /suspended is an informational
    // notice; the reader would have to find a second button. Same standard as the warning email's CTA.
    const e = renderFreeOrgCapSuspendedEmail(SUSPEND, ORG);
    expect(e.html).toContain("https://app.webhook.co/org/acme-inc/billing");
    expect(e.html).toContain("Upgrade to restore");
    expect(e.html).not.toContain("/org/acme-inc/suspended");
  });

  it("makes NO promise about restore timing or held deliveries — both were false", () => {
    // "restores within the hour": the restore lands on this cron's pass, but the held backlog is re-woken by a
    // SEPARATE hourly cron with no ordering between them. "held deliveries go out automatically": the
    // retention prune cascade-deletes delivery_attempts with their events, so on a free org they may simply
    // be gone. Retention is the only real time-pressure and the copy states that instead.
    const e = renderFreeOrgCapSuspendedEmail(SUSPEND, ORG);
    expect(e.text).not.toMatch(/within the hour|go(ing)? out automatically|held for delivery/i);
    expect(e.text).toContain("the sooner you restore it, the more history you keep");
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
    expect(e.html).toContain("https://app.webhook.co/org/..%2F..%2Fevil/billing");
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

  it("keeps the neutral fallback GRAMMATICAL both sentence-initial and mid-sentence", () => {
    // This is the exact path the notifier's LEFT JOIN exists to serve, so it must not read as broken.
    const e = renderFreeOrgCapWarningEmail(WARN, { name: null, slug: null });
    expect(e.html).toContain("One of your organizations will be suspended"); // sentence-initial → capitalized
    expect(e.text).toContain("upgrade one of your organizations to a paid plan"); // mid-sentence → lowercase
    expect(e.text).not.toContain("and One of your organizations is over that limit");
  });

  it("does not capitalize a real org name the user deliberately lower-cased", () => {
    const e = renderFreeOrgCapSuspendedEmail(SUSPEND, { name: "acme", slug: "acme" });
    expect(e.subject).toBe("acme has been suspended");
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

  it("renders a valid email from a NULL context — the drain claims first, so refusing loses it forever", () => {
    for (const e of [
      renderFreeOrgCapWarningEmail(null, ORG),
      renderFreeOrgCapSuspendedEmail(null, ORG),
    ]) {
      expect(e.subject).toContain("Acme Inc");
      expect(e.html).toContain("a limited number of free organizations per user");
      expect(e.html).not.toContain("undefined");
      expect(e.html).not.toContain("NaN");
    }
    expect(renderFreeOrgCapWarningEmail(null, ORG).subject).toBe(
      "Heads up: Acme Inc will be suspended soon",
    );
  });

  it("describes the limit without a number when the cap is unusable", () => {
    for (const cap of [0, -1, 1.5, Number.NaN] as number[]) {
      for (const e of [
        renderFreeOrgCapWarningEmail({ ...WARN, cap }, ORG),
        renderFreeOrgCapSuspendedEmail({ cap }, ORG),
      ]) {
        expect(e.html).toContain("a limited number of free organizations per user");
        expect(e.html).not.toContain("up to ");
        expect(e.html).not.toContain("NaN");
      }
    }
  });
});
