import { expect, test } from "@playwright/test";

// The login page's real-browser smoke gate.
//
// Why this exists: /login is the single door into the product. The issuer bounces unauthenticated
// /authorize here, and app.'s session handoff bounces here. Until now NOTHING in CI opened it in a
// browser — the jsdom suite (login-form.test.tsx) injects a FAKE captcha through the `Captcha` prop
// precisely so Cloudflare's script never touches jsdom, and build-cf only compiles. So a CSP
// violation, a hydration failure, or a third-party script that throws would ship green.
//
// That blind spot is why this landed BEFORE Google One Tap did: One Tap puts a second third-party
// script on this page, and adding it without a browser-level baseline would mean the first time
// anyone ran /login in a browser under the new CSP was in production.
//
// Deliberately NOT asserted: that the Turnstile widget SOLVES. That needs Cloudflare's CDN to answer
// and its iframe to complete a challenge — a real network dependency and a documented flake source in
// this repo. Every assertion below holds without any third-party script EXECUTING: Cloudflare's is never
// waited on, and Google's is stubbed for every test (see the beforeEach).

/** Third-party hosts whose console noise is not ours to gate (a CDN hiccup is not our regression). */
const THIRD_PARTY = ["challenges.cloudflare.com", "accounts.google.com"];

const GOOGLE_HOST = "accounts.google.com";

/**
 * The hostname of a URL-ish string, or "" when it is not a URL.
 *
 * Everything here compares HOSTS exactly rather than substring-matching the URL. `url.includes(host)` is
 * the shape CodeQL flags as incomplete URL sanitization, and it is genuinely wrong even in a test:
 * `https://evil.test/?next=accounts.google.com` matches it. A CSP `blockedURI` is also not always a URL —
 * it can be the literal `eval` or `inline` — hence the tolerant parse rather than a bare `new URL`.
 */
function hostOf(value: string): string {
  try {
    return new URL(value).hostname;
  } catch {
    return "";
  }
}

interface CspViolation {
  violatedDirective: string;
  blockedURI: string;
  /** Captured because a violation without a source location is close to undiagnosable in CI. */
  sourceFile: string;
}

/**
 * The ONE violation this page already emits, and why it is tolerated rather than fixed or papered over.
 *
 * Zod feature-detects whether the runtime will let it JIT-compile validators, with a literal
 * `try { Function(""); return true } catch { return false }`. Our CSP has no `'unsafe-eval'`, so the
 * probe throws, Zod catches it and takes its interpreted path, and everything works. It reaches this page
 * through better-auth's browser client. Confirmed by reading the built chunk, not inferred: the probe sits
 * next to Zod's `jitless` flag.
 *
 * So it is a REPORT, not a failure — nothing is broken and no behaviour changes. Adding `'unsafe-eval'`
 * to silence it would trade a real security property for a cosmetic one, on the page that mints sessions.
 *
 * The exemption is deliberately narrow: `script-src`/`eval` only, and AT MOST ONE of them. Any violation
 * with a different directive or a different blocked URI still fails, which is exactly what has to happen
 * when a new third-party script lands on this page.
 */
const KNOWN_VIOLATIONS = [{ violatedDirective: "script-src", blockedURI: "eval" }];

const isKnown = (v: CspViolation) =>
  KNOWN_VIOLATIONS.some(
    (k) => k.violatedDirective === v.violatedDirective && k.blockedURI === v.blockedURI,
  );

declare global {
  interface Window {
    __cspViolations?: CspViolation[];
  }
}

/** Record CSP violations from inside the page. `addInitScript` runs before any page script. */
async function captureCspViolations(page: import("@playwright/test").Page): Promise<void> {
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      window.__cspViolations?.push({
        violatedDirective: event.violatedDirective,
        blockedURI: event.blockedURI,
        sourceFile: event.sourceFile,
      });
    });
  });
}

test.describe("/login", () => {
  // HERMETIC BY DEFAULT. Every test in this file stubs accounts.google.com, so no assertion here depends
  // on Google being reachable — which is what the header above promises and what two of these tests were
  // quietly breaking before. It matters beyond flakiness: with a placeholder client id registered to no
  // Google project, the real GSI script emits errors attributed to OUR document, and the console-error
  // test would then fail for a reason no commit caused.
  //
  // An EMPTY script body is deliberate. The question these tests can answer is whether the browser was
  // ALLOWED to fetch GSI under the production CSP — a refusal blocks the request before any route handler
  // runs. Whether Google's real script then initializes is a question only a human with a live Google
  // session can settle, and it is on the ADR's verification checklist.
  test.beforeEach(async ({ page }) => {
    await page.route("https://accounts.google.com/**", async (route) => {
      await route.fulfill({ status: 200, contentType: "text/javascript", body: "" });
    });
  });

  test("renders the sign-in form and hydrates", async ({ page }) => {
    await page.goto("/login");

    await expect(page.getByRole("heading", { name: "Sign in to webhook.co" })).toBeVisible();
    await expect(page.getByLabel("Work email")).toBeVisible();
    // Queried by its aria-label, not its text: the SSO button sets `aria-label="SAML single sign-on,
    // coming soon"` (login-form.tsx:240), and an aria-label REPLACES the accessible name rather than
    // supplementing it — so "Continue with SSO" matches nothing by role.
    await expect(page.getByRole("button", { name: /SAML single sign-on/ })).toBeDisabled();
    await expect(page.getByText("No account yet? Signing in creates one.")).toBeVisible();

    // Hydration, proven WITHOUT the network. The Turnstile component appends Cloudflare's <script> from
    // inside a React effect (turnstile.tsx:114), so the tag's presence means the effect ran — i.e. the
    // client bundle loaded and React hydrated. The tag appears the moment the effect runs; whether
    // Cloudflare then answers is irrelevant here.
    //
    // This guards a specific, documented, and badly-misleading failure: next.config.ts:14-19 explains
    // that serving from an origin outside `allowedDevOrigins` refuses the client bundle, so React never
    // hydrates — and it presents as "the captcha is broken", not as a host mismatch. A test that only
    // checked the server HTML would pass straight through it, because the HTML and the CSP arrive fine.
    await expect(page.locator('head script[src^="https://challenges.cloudflare.com"]')).toHaveCount(
      1,
    );

    // The captcha's own container is OUR dom (turnstile.tsx:152), not Cloudflare's iframe.
    await expect(page.locator(".cf-turnstile")).toHaveCount(1);
  });

  test("emits no CSP violations", async ({ page }) => {
    await captureCspViolations(page);
    await page.goto("/login");
    await expect(page.locator(".cf-turnstile")).toHaveCount(1);

    // Give any late-loading third-party script a chance to trip the policy before we read the tally.
    await page.waitForTimeout(2_000);

    const violations = await page.evaluate(() => window.__cspViolations ?? []);

    // Anything we have not explicitly accounted for fails, with its source file in the message.
    expect(violations.filter((v) => !isKnown(v))).toEqual([]);
    // …and the accounted-for one must not multiply. Zod memoizes its probe, so it runs once; more than
    // one would mean a SECOND thing is now trying to eval, which is a change worth failing on.
    expect(violations.filter(isKnown).length).toBeLessThanOrEqual(1);
  });

  test("logs no console errors from our own code", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      // Scope to OUR origin on purpose: a Cloudflare/Google CDN failure is a third-party outage, not a
      // regression in this repo, and gating on it would make the suite fail for reasons no commit caused.
      // Everything our bundle logs still fails this test.
      const source = hostOf(message.location().url);
      if (THIRD_PARTY.includes(source)) return;
      errors.push(`${source}: ${message.text()}`);
    });

    await page.goto("/login");
    await expect(page.locator(".cf-turnstile")).toHaveCount(1);
    await page.waitForTimeout(2_000);

    expect(errors).toEqual([]);
  });

  test("keeps the magic-link divider in step with the social buttons", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByLabel("Work email")).toBeVisible();

    // login-form.tsx renders the social block (:176) and the "magic link" divider (:205) behind the SAME
    // condition. Asserting the invariant rather than a fixed count means this holds under every provider
    // configuration — including OAUTH_MODE=optional, where both are correctly absent — while still failing
    // if the two conditions ever drift apart and leave a divider heading an empty section.
    const socialButtons = await page
      .getByRole("button", { name: /^Continue with (Google|GitHub)$/ })
      .count();
    const dividers = await page.getByText("magic link", { exact: true }).count();

    expect(dividers).toBe(socialButtons > 0 ? 1 : 0);
  });

  // --- Google One Tap -------------------------------------------------------------------------------
  // Hermetic by construction: accounts.google.com is intercepted, so these assertions hold with no
  // Google byte arriving and CI never depends on Google's uptime. What they prove is exactly what a unit
  // test cannot — that the browser was ALLOWED to request the GSI script under the real production CSP.
  test("requests the Google Identity Services script, and the CSP permits it", async ({ page }) => {
    await captureCspViolations(page);

    const gsiRequests: string[] = [];
    page.on("request", (r) => {
      if (hostOf(r.url()) === GOOGLE_HOST) gsiRequests.push(new URL(r.url()).pathname);
    });

    await page.goto("/login");
    await expect(page.locator(".cf-turnstile")).toHaveCount(1);
    await page.waitForTimeout(2_000);

    expect(gsiRequests).toContain("/gsi/client");

    // The specific failure this catches: a script-src that omits accounts.google.com. That produces a
    // `script-src-elem` violation naming the GSI URL and NO request at all — which is precisely how the
    // discovery pass first observed it.
    const violations = await page.evaluate(() => window.__cspViolations ?? []);
    expect(violations.filter((v) => hostOf(v.blockedURI) === GOOGLE_HOST)).toEqual([]);
  });

  test("reaches Google ONLY for the GSI endpoints, nothing else", async ({ page }) => {
    // Named for what it actually asserts. The CI fixture CONFIGURES Google, so this cannot exercise the
    // unconfigured case — `googleOneTapClientId()` returning null is covered by one-tap-config.test.ts,
    // and the "no prompt without a client id" wiring by login-actions. What a browser adds here is the
    // egress shape: with the prompt active, the only origin traffic is /gsi/*, so a future change that
    // starts beaconing somewhere else on this page fails loudly.
    const attempted: string[] = [];
    page.on("request", (r) => {
      if (hostOf(r.url()) === GOOGLE_HOST) attempted.push(new URL(r.url()).pathname);
    });

    await page.goto("/login");
    await page.waitForTimeout(2_000);

    expect(attempted.length).toBeGreaterThan(0);
    for (const path of attempted) expect(path.startsWith("/gsi/")).toBe(true);
  });

  test("offers both social providers in the production shape", async ({ page }) => {
    // Production always provisions both OAuth apps (readAuthEnv requires all four secrets), so both
    // buttons are the shape this page ships in. CI pins that shape by writing a .dev.vars with
    // placeholder OAuth ids; locally the standard dev setup supplies real ones.
    //
    // A contributor running OAUTH_MODE=optional with no OAuth app will see this one test fail — correctly,
    // because it is asserting the production shape, and the invariant test above is the one that covers
    // their configuration. Recorded in docs/local-parity.md.
    await page.goto("/login");

    await expect(page.getByRole("button", { name: "Continue with Google" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Continue with GitHub" })).toBeEnabled();
  });
});
