import assert from "node:assert/strict";
import { test } from "node:test";

import { findClaims } from "./no-unverified-claims.mjs";

const hits = (line) => findClaims(line, "x.tsx", 1).map((h) => h.id);

// ── the claims we actually shipped ────────────────────────────────────────────

test("catches the three invented login stats", () => {
  assert.deepEqual(hits('<Stat n="99.99%" k="delivery SLA" />'), ["uptime-sla"]);
  assert.deepEqual(hits('<Stat n="38ms" k="median latency" />'), [
    "latency-metric",
    "latency-metric-reversed",
  ]);
  assert.deepEqual(hits('<Stat n="3.4M" k="events / day" />'), ["volume-metric"]);
});

test("catches the fake status indicator", () => {
  assert.deepEqual(hits("All systems operational"), ["status-indicator"]);
});

test("catches selling a BAA our Terms refuse", () => {
  assert.deepEqual(hits('summary: "Committed volume, SAML SSO, audit export, and a BAA."'), [
    "baa-offer",
  ]);
  assert.deepEqual(hits("Need more than Scale, SSO, or a BAA?"), ["baa-offer"]);
});

test("catches certification claims we can't make", () => {
  assert.deepEqual(hits("We are SOC 2 compliant"), ["certification-claim"]);
  assert.deepEqual(hits("HIPAA certified infrastructure"), ["certification-claim"]);
});

test("catches invented social proof", () => {
  // Trips both rules — "trusted by <n>" AND "<n> developers". Overlap is fine: the rules are a net,
  // not a taxonomy, and a claim caught twice is still caught.
  assert.deepEqual(hits("Trusted by 4,000 developers"), ["social-proof-count", "customer-count"]);
  assert.deepEqual(hits("Join 12,000 engineers"), ["customer-count"]);
});

test("catches guarantees the engine cannot make", () => {
  assert.deepEqual(hits("guaranteed delivery"), ["guarantee"]);
  assert.deepEqual(hits("You never lose an event"), ["guarantee"]);
});

// ── THE LOAD-BEARING PART ─────────────────────────────────────────────────────
// The legal pages are the BASELINE OF TRUTH the marketing surfaces were violating. They must keep
// saying, out loud, what we do NOT have. A guard that silenced them would be worse than the bug:
// it would launder the honesty out of the product. These rules match the SHAPE of a boast — a number
// bound to a unit, a cert bound to a claim verb — never the bare noun.

test("never flags the legal pages saying what we DON'T have", () => {
  assert.deepEqual(hits("We hold no SOC 2, ISO 27001, HIPAA, or PCI certification"), []);
  assert.deepEqual(hits("we do not sign BAAs"), []);
  assert.deepEqual(hits("provide no BAA or PCI attestation"), []);
  assert.deepEqual(
    hits("best-effort basis with no guaranteed uptime or service-level commitment"),
    [],
  );
  assert.deepEqual(hits("no uptime guarantee on self-serve plans"), []);
  assert.deepEqual(
    hits("SLAs and response-time commitments are available only under an enterprise agreement"),
    [],
  );
});

// The real privacy policy wraps mid-sentence:
//     We&apos;re <strong>not</strong>{" "}
//     SOC 2 / HIPAA certified, so please don&apos;t send data that needs those.
// The negation and the claim land on DIFFERENT LINES. A line-local denial check flags the privacy
// policy for telling the truth — which is the one thing this guard must never do. So denial is judged
// over a window, and this test is the reason why.
test("never flags a denial that wrapped onto the previous line", () => {
  const wrapped = [
    '            <strong>honour erasure requests within 30 days</strong>. We&apos;re <strong>not</strong>{" "}',
    "            SOC 2 / HIPAA certified, so please don&apos;t send data that needs those.",
  ];
  const context = wrapped.join(" ");
  assert.deepEqual(findClaims(wrapped[1], "privacy/page.tsx", 48, context), []);

  // …but the SAME claim line with no denial anywhere in the window is still a violation.
  const boast = "            SOC 2 / HIPAA certified, so send us whatever you like.";
  assert.deepEqual(
    findClaims(boast, "privacy/page.tsx", 48, boast).map((h) => h.id),
    ["certification-claim"],
  );
});

test("never flags the honest trust-band statement", () => {
  assert.deepEqual(
    hits("We hold no SOC 2 or HIPAA certification today, and we'd rather say so"),
    [],
  );
});

// ── things that are true and must survive ─────────────────────────────────────

test("never flags the real pricing numbers", () => {
  assert.deepEqual(hits('includedEvents: "500,000 events / month"'), []);
  assert.deepEqual(hits('overage: "€25 per extra million events"'), []);
  assert.deepEqual(hits('retention: "30-day retention"'), []);
  assert.deepEqual(hits("5,000 events, once"), []);
});

test("never flags the real provider count", () => {
  // 142 is derived from the actual adapter registry — it is one of the few numbers we can prove.
  assert.deepEqual(hits("across 142 providers, from HMAC to Ed25519"), []);
});

test("never flags product description without a metric", () => {
  assert.deepEqual(hits("Durable delivery, automatic retries, and end-to-end observability"), []);
  assert.deepEqual(hits("Failed deliveries retry with backoff"), []);
});
