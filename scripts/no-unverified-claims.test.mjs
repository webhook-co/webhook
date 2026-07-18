import assert from "node:assert/strict";
import { test } from "node:test";

import { scanSource, scanMdx } from "./no-unverified-claims.mjs";

/**
 * These call `scanSource` — the function the scanner actually runs on every file.
 *
 * The first version of this suite tested a per-line helper with a defaulted `context` argument. It
 * was green, and it was worthless: production judged denial over a 2-line lookback that no test ever
 * built, so every "the legal pages survive" assertion was passing against a code path that didn't
 * ship. A guard's tests have to run the guard.
 */
const ids = (src) => scanSource(src).map((h) => h.id);

// ── the claims we actually shipped ────────────────────────────────────────────

test("catches the three invented login stats", () => {
  assert.deepEqual(ids('<Stat n="99.99%" k="delivery SLA" />'), ["uptime-sla"]);
  assert.deepEqual(ids('<Stat n="38ms" k="median latency" />'), [
    "latency-metric",
    "latency-metric-reversed",
  ]);
  assert.deepEqual(ids('<Stat n="3.4M" k="events / day" />'), ["volume-metric"]);
});

// THE EVASION THAT WOULD HAVE SHIPPED. Nest that <Stat> one level deeper and prettier wraps it — and
// a line-by-line guard then sees a magnitude on one line and a unit on another, and finds nothing.
// The claim a reader sees is identical; only the whitespace moved.
test("catches a stat that prettier wrapped across lines", () => {
  assert.deepEqual(
    ids(`
      <Stat
        n="3.4M"
        k="events / day"
      />`),
    ["volume-metric"],
  );
  assert.deepEqual(
    ids(`
      <Stat
        n="99.99%"
        k="delivery SLA"
      />`),
    ["uptime-sla"],
  );
});

test("catches the fake status indicator", () => {
  assert.deepEqual(ids("<span>All systems operational</span>"), ["status-indicator"]);
});

test("catches selling a BAA our Terms refuse — singular OR plural", () => {
  // The full shipped string trips all three capability rules — BAA, SSO and audit export. It claimed
  // three things we don't do, for €499/mo.
  assert.deepEqual(ids('summary: "Committed volume, SAML SSO, audit export, and a BAA."'), [
    "baa-offer",
    "sso-offer",
    "audit-export-offer",
  ]);
  // The in-product billing page's upsell — the same false promise, repeated to a PAYING customer.
  assert.deepEqual(ids("<p>Need more than Scale, SSO, or a BAA?</p>"), ["baa-offer", "sso-offer"]);
  // The plural slipped through the first version — and "we sign BAAs" is the AUP's own phrasing.
  assert.deepEqual(ids("<p>Committed volume, SAML SSO, and we sign BAAs.</p>"), [
    "baa-offer",
    "sso-offer",
  ]);
  assert.deepEqual(ids("<p>BAAs available on request.</p>"), ["baa-offer"]);
});

// The Enterprise tier sold "SAML SSO, audit export, and a BAA". Deleting those words is not the same
// as pinning them: without a rule, the exact string can be pasted back tomorrow and CI stays green.
// The BAA half was guarded from the start; these two were not, which is the gap that let a false
// €499 capability claim sit one regex away from returning.
test("catches selling SSO we haven't built", () => {
  assert.deepEqual(ids('summary: "Committed volume, SAML SSO, audit export."'), [
    "sso-offer",
    "audit-export-offer",
  ]);
  assert.deepEqual(ids("<p>Enterprise includes SAML single sign-on.</p>"), ["sso-offer"]);
});

// The ONE honest SSO surface: a disabled button that says so. It must survive, or the guard forces us
// to delete the truthful thing along with the false one.
test("never flags the disabled 'coming soon' SSO button", () => {
  assert.deepEqual(
    ids(`<Button variant="secondary" disabled aria-label="SAML single sign-on, coming soon">
           Continue with SSO
         </Button>`),
    [],
  );
});

test("catches selling an audit export that does not exist", () => {
  assert.deepEqual(ids("<p>Audit log export on Enterprise.</p>"), ["audit-export-offer"]);
  assert.deepEqual(ids("<p>Export your audit trail at any time.</p>"), ["audit-export-offer"]);
});

test("catches certification claims we can't make", () => {
  assert.deepEqual(ids("<p>We are SOC 2 compliant</p>"), ["certification-claim"]);
  assert.deepEqual(ids("<p>HIPAA certified infrastructure</p>"), ["certification-claim"]);
});

test("catches invented social proof", () => {
  // Trips both rules — "trusted by <n>" AND "<n> developers". Overlap is fine: the rules are a net,
  // not a taxonomy, and a claim caught twice is still caught.
  assert.deepEqual(ids("<p>Trusted by 4,000 developers</p>"), [
    "social-proof-count",
    "customer-count",
  ]);
  assert.deepEqual(ids("<p>Join 12,000 engineers</p>"), ["customer-count"]);
});

test("catches guarantees the engine cannot make", () => {
  assert.deepEqual(ids("<p>guaranteed delivery</p>"), ["guarantee"]);
  assert.deepEqual(ids("<p>You never lose an event</p>"), ["guarantee"]);
});

// ── denial must be IN THE CLAUSE, not merely nearby ───────────────────────────
// A denial judged over a loose neighbourhood is a skeleton key: any incidental "no"/"never" in the
// vicinity unlocks a boast. These are the laundering routes the review found.

test("a denial in a NEIGHBOURING sentence does not launder a boast", () => {
  assert.deepEqual(
    ids(
      "<p>Your webhook data is never shared with third parties. We are SOC 2 Type II certified.</p>",
    ),
    ["certification-claim"],
  );
});

test("a denial in a CODE COMMENT does not launder a boast", () => {
  assert.deepEqual(
    ids(`
      // we do not sign BAAs — see the AUP
      const tier = { summary: "Committed volume, audit export, and a BAA." };`),
    ["baa-offer", "audit-export-offer"],
  );
  assert.deepEqual(
    ids(`
      {/* We are not SOC 2 certified and must never claim to be. */}
      <p>We are SOC 2 Type II certified.</p>`),
    ["certification-claim"],
  );
});

// ── THE LOAD-BEARING PART ─────────────────────────────────────────────────────
// The legal pages are the BASELINE OF TRUTH the marketing surfaces were violating. They must keep
// saying, out loud, what we do NOT have. A guard that silenced them would be worse than the bug:
// it would launder the honesty out of the product and leave only the boasts.

test("never flags the legal pages saying what we DON'T have", () => {
  assert.deepEqual(ids("<p>We hold no SOC 2, ISO 27001, HIPAA, or PCI certification.</p>"), []);
  assert.deepEqual(ids("<p>we do not sign BAAs</p>"), []);
  assert.deepEqual(ids("<p>provide no BAA or PCI attestation</p>"), []);
  assert.deepEqual(
    ids("<p>best-effort basis with no guaranteed uptime or service-level commitment</p>"),
    [],
  );
  assert.deepEqual(ids("<p>no uptime guarantee on self-serve plans</p>"), []);
});

// The real privacy policy wraps mid-sentence, with the negation on a different line from the claim:
//     We&apos;re <strong>not</strong>{" "}
//     SOC 2 / HIPAA certified, so please don&apos;t send data that needs those.
// Normalizing whitespace is what keeps the denial attached to the claim it denies.
test("never flags a denial that wrapped onto the previous line", () => {
  assert.deepEqual(
    ids(`
        <strong>honour erasure requests within 30 days</strong>. We&apos;re <strong>not</strong>{" "}
        SOC 2 / HIPAA certified, so please don&apos;t send data that needs those.`),
    [],
  );
});

test("never flags the honest trust-band statement", () => {
  assert.deepEqual(
    ids("<p>We hold no SOC 2 or HIPAA certification today, and we&apos;d rather say so.</p>"),
    [],
  );
});

// ── things that are true and must survive ─────────────────────────────────────

test("never flags the real pricing numbers", () => {
  assert.deepEqual(ids('includedEvents: "500,000 events / month"'), []);
  assert.deepEqual(ids('overage: "€25 per extra million events"'), []);
  assert.deepEqual(ids('retention: "30-day retention"'), []);
  assert.deepEqual(ids('cap: "5,000 events, once"'), []);
});

// A plan QUOTA is the billed contract — the one volume number we can prove. Banning it would push the
// next contributor to weaken the rule, which is how a guard dies.
test("never flags an abbreviated plan quota", () => {
  assert.deepEqual(ids("<p>Your plan includes 5M events per month.</p>"), []);
  assert.deepEqual(ids('overage: "€25 per extra 1M events, up to 20M events"'), []);
  // …but a boast about OUR throughput, with no quota framing, still fails.
  assert.deepEqual(ids("<p>We process 3.4M events / day.</p>"), ["volume-metric"]);
});

test("never flags the real provider count", () => {
  assert.deepEqual(ids("<p>across 142 providers, from HMAC to Ed25519</p>"), []);
});

test("never flags product description without a metric", () => {
  assert.deepEqual(
    ids("<p>Durable delivery, automatic retries, and end-to-end observability</p>"),
    [],
  );
  assert.deepEqual(ids("<p>Failed deliveries retry with backoff</p>"), []);
});

// The guard must not flag its own documentation. A wrapped JSX comment explaining a removed claim is
// the most likely thing a future contributor writes — and the first version red-lit CI on exactly it.
test("never flags a multi-line comment that quotes the banned claims", () => {
  assert.deepEqual(
    ids(`
      {/* We removed the fabricated stat block that claimed 99.99% uptime SLA
          and 38ms median latency, plus "3.4M events / day". Do not re-add. */}
      <div />`),
    [],
  );
  assert.deepEqual(
    ids(`
      /**
       * Was: "All systems operational" — wired to nothing. We are not SOC 2 certified.
       */
      const Footer = () => null;`),
    [],
  );
});

// ── MDX (apps/docs) — the knowledge base is a new user-facing surface ──────────
// The KB publishes exactly the shape of claim this guard exists to stop (SLA, certs, SSO, BAA), but
// in MDX, not TSX. MDX is NOT JavaScript: prose is full of apostrophes and quotes that the JS
// comment-stripper would mis-read as string literals, and code fences hold example payloads whose
// numbers must never be mistaken for a boast. `scanMdx` strips MDX code + comments (not JS strings)
// and then runs the SAME claim rules and clause-scoped denial as production.
const mdxIds = (src) => scanMdx(src).map((h) => h.id);

test("scanMdx catches a prose claim in a KB article", () => {
  assert.deepEqual(mdxIds("We are SOC 2 Type II certified."), ["certification-claim"]);
  assert.deepEqual(mdxIds("webhook.co offers a 99.9% uptime SLA."), ["uptime-sla"]);
});

test("scanMdx catches a claim inside a Mintlify component", () => {
  assert.deepEqual(mdxIds('<Stat n="99.99%" k="delivery SLA" />'), ["uptime-sla"]);
  // Order follows CLAIM_RULES: baa-offer precedes sso-offer.
  assert.deepEqual(mdxIds('<Card title="SAML SSO and a BAA" />'), ["baa-offer", "sso-offer"]);
});

// THE REASON scanMdx exists and scanSource is not reused: an apostrophe in prose ("We're", "they'd")
// must not swallow the rest of the line as a JS string literal and hide the claim behind it — and a
// double-quoted phrase in prose must not either.
test("scanMdx is not fooled by prose apostrophes and quotes", () => {
  assert.deepEqual(mdxIds("We're SOC 2 certified. Don't worry."), ["certification-claim"]);
  assert.deepEqual(mdxIds(`They call it "enterprise-grade" — we are HIPAA certified.`), [
    "certification-claim",
  ]);
});

// Code samples are examples, not claims. A fenced block showing a log line or a JSON body must never
// trip a rule, or every realistic troubleshooting article fails the gate.
test("scanMdx ignores claims inside a fenced code block", () => {
  assert.deepEqual(
    mdxIds(
      ["Here is an example log line:", "```", "p99 latency 38ms — median latency high", "```"].join(
        "\n",
      ),
    ),
    [],
  );
  assert.deepEqual(
    mdxIds(["```json", '{ "throughput": "3.4M events / day" }', "```"].join("\n")),
    [],
  );
  // A tilde fence with an info string, too.
  assert.deepEqual(mdxIds(["~~~text", "All systems operational", "~~~"].join("\n")), []);
});

test("scanMdx ignores claims inside inline code", () => {
  assert.deepEqual(mdxIds("The `99.9% uptime SLA` header is illustrative only."), []);
});

test("scanMdx ignores claims inside an MDX expression comment", () => {
  assert.deepEqual(
    mdxIds("{/* TODO: we are NOT SOC 2 certified — do not add a badge */}\nInspect your events."),
    [],
  );
});

// A claim after a closed code fence must still be caught — the fence stripper must not run away.
test("scanMdx still catches a claim that follows a code fence", () => {
  assert.deepEqual(
    mdxIds(
      ["```", "curl https://api.webhook.co/v1/events", "```", "", "We are SOC 2 certified."].join(
        "\n",
      ),
    ),
    ["certification-claim"],
  );
});

// The KB's honest security page MUST be able to say, in prose, exactly which certifications we do
// NOT hold — same load-bearing invariant as the legal pages, now in MDX. (We do NOT publish articles
// enumerating other absent features like SSO/2FA — the gap policy sends those to the backlog, not the
// docs — so the intentionally strict `sso-offer` rule stays strict; scanMdx still catches a positive
// SSO offer, proven above.)
test("scanMdx never flags the honest 'we hold none of these' certification statement", () => {
  assert.deepEqual(
    mdxIds("We hold no SOC 2, ISO 27001, HIPAA, or PCI certification, and we'd rather say so."),
    [],
  );
  assert.deepEqual(
    mdxIds("This page describes engineering practices, not a certification of any kind."),
    [],
  );
});

// A plan quota is the billed contract, true and provable — it must survive in KB prose too.
test("scanMdx never flags a plan quota in KB prose", () => {
  assert.deepEqual(mdxIds("Your Pro plan includes up to 500,000 events per month."), []);
  assert.deepEqual(mdxIds("across 142 providers, from HMAC to Ed25519"), []);
});
