# Invite return-through-login — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A brand-new invitee returns to `/invite/accept` after signup, accepts (joins the team), then gets name-only onboarding — instead of being misclassified as a fresh signup.

**Architecture:** Opt-in `returnTo` threaded (path only) through the existing auth login handoff; the invite token rides an **encrypted app-origin cookie**, never the auth origin. A ported same-origin guard validates the reflected `next` at both the auth handoff and app's callback. No DB migration.

**Tech Stack:** Next.js 16 on OpenNext/Cloudflare Workers; Web Crypto (`crypto.subtle`, AES-256-GCM + HKDF); Better Auth 1.6.23 (`callbackURL` carried through OAuth state / magic-link); vitest + jsdom.

## Global Constraints

- **Design of record:** `docs/superpowers/specs/2026-07-14-invite-return-through-login-design.md`. Everything here implements that spec.
- **TDD, strictly** (red → green → refactor). No `.only`, no skipped tests, no weakened gate (AGENTS.md #2).
- **No new secret provisioning:** the cookie key is HKDF-derived from `getSessionSecret()` (`SESSION_TOKEN_SECRET`) with a distinct `info` label. Never reuse a key across HMAC (session token) and AES (invite cookie).
- **returnTo is opt-in:** only `/invite/accept` builds a login-with-`next` URL. `verifySession()`'s default redirect stays unchanged.
- **`next` is a relative app path only.** Every reflection point validates it same-origin against the **app** origin; failure → `/`. Never an absolute URL.
- **`next` must be percent-encoded EXACTLY ONCE** or Better Auth 403s (`INVALID_CALLBACK_URL`). Its accepting regex for a relative callbackURL: `^\/(?!\/|\\|%2f|%5c)[\w\-.\+/@]*(?:\?[\w\-.\+/=&%@]*)?$` — the query char-class has no `?` and the path has no `%`, so the nested app path must be encoded once.
- **Token hygiene:** the raw invite token appears only on the app origin (inbox, encrypted cookie, existing-user URL). It is NEVER placed in an auth-origin URL, in the rendered HTML for the new-user path, or in logs.
- **Cross-repo mechanics:** feature branch `feat/invite-return-through-login`; full gate + `/code-review` + `/security-review` before merge (security-review MANDATORY — auth redirects + a bearer token).

---

### Task 1: Shared same-origin `next` guard

Port the proven `resolvePostLoginTarget` origin-check into a reusable, origin-parameterized helper used by BOTH the auth handoff and app's callback to validate the app-path `next`.

**Files:**
- Create: `packages/shared/src/return-path.ts`
- Test: `packages/shared/src/return-path.test.ts`
- Modify: `packages/shared/src/index.ts` (add `export * from "./return-path";`)

**Interfaces:**
- Produces: `sanitizeReturnPath(candidate: string | null | undefined, origin: string): string | null` — returns the candidate iff it is a safe same-origin relative path with a real destination after the leading slash; otherwise `null`. `origin` is the absolute origin to resolve against (the APP origin at every call site here).

- [ ] **Step 1: Write the failing test** (`packages/shared/src/return-path.test.ts`)

```ts
import { describe, expect, it } from "vitest";
import { sanitizeReturnPath } from "./return-path";

const APP = "https://app.webhook.co";

describe("sanitizeReturnPath", () => {
  it("accepts a genuine same-origin path (with query)", () => {
    expect(sanitizeReturnPath("/invite/accept?org=abc", APP)).toBe("/invite/accept?org=abc");
    expect(sanitizeReturnPath("/org/acme/dashboard", APP)).toBe("/org/acme/dashboard");
  });

  it("rejects null / empty / bare slash (no destination)", () => {
    for (const v of [null, undefined, "", "/"]) expect(sanitizeReturnPath(v, APP)).toBeNull();
  });

  it("rejects protocol-relative and backslash origin escapes", () => {
    for (const v of ["//evil.com", "/\\evil.com", "/%2Fevil.com", "/%2fevil.com", "/%5Cevil.com"]) {
      expect(sanitizeReturnPath(v, APP)).toBeNull();
    }
  });

  it("rejects absolute URLs and scheme smuggling", () => {
    for (const v of ["https://evil.com", "https:/evil.com", "http://app.webhook.co.evil.com"]) {
      expect(sanitizeReturnPath(v, APP)).toBeNull();
    }
  });

  it("strips the control chars a browser strips from a Location, then judges the result", () => {
    // "/\t/evil.com" → browser parses as "//evil.com" → different origin → reject.
    for (const v of ["/\t/evil.com", "/\n/evil.com", "/\r/evil.com", "\t//evil.com"]) {
      expect(sanitizeReturnPath(v, APP)).toBeNull();
    }
  });
});
```

- [ ] **Step 2: Run it, verify it fails** — `pnpm --filter @webhook-co/shared test return-path` → FAIL (module not found).

- [ ] **Step 3: Implement** (`packages/shared/src/return-path.ts`)

```ts
/**
 * Validate an untrusted `returnTo`/`next` value as a SAME-ORIGIN relative path — an origin check, not a
 * byte-pattern (ported from apps/auth's resolvePostLoginTarget, generalized over the origin). Browsers strip
 * \t\n\r while parsing a Location, so we strip them first and judge the value the browser will act on. A bare
 * "/" is not a destination. Returns the candidate when safe, else null (caller falls back to "/").
 */
export function sanitizeReturnPath(
  candidate: string | null | undefined,
  origin: string,
): string | null {
  if (candidate == null) return null;
  const cleaned = candidate.replace(/[\t\n\r]/g, "");
  // Absolute path, real destination after the slash, never // or /\ (origin escapes).
  if (!/^\/[^/\\]/.test(cleaned)) return null;
  try {
    if (new URL(cleaned, origin).origin === new URL(origin).origin) return cleaned;
  } catch {
    // unparseable → not trusted
  }
  return null;
}
```

- [ ] **Step 4: Run tests, verify pass** — `pnpm --filter @webhook-co/shared test return-path` → PASS.

- [ ] **Step 5: Commit** — `git add packages/shared/src/return-path.ts packages/shared/src/return-path.test.ts packages/shared/src/index.ts && git commit -m "feat(shared): same-origin returnTo path guard"`

---

### Task 2: Encrypted invite cookie (seal/open + accessors)

**Files:**
- Create: `apps/web/src/server/invite-cookie.ts`
- Test: `apps/web/src/server/invite-cookie.test.ts`

**Interfaces:**
- Consumes: `getSessionSecret(): Promise<string>` from `@/server/env`.
- Produces:
  - `sealInvitePayload(payload: { org: string; token: string }, secret: string, nowMs: number): Promise<string>` — AES-256-GCM ciphertext (base64url) with an embedded ~15-min expiry; pure over `nowMs` so tests are deterministic.
  - `openInvitePayload(sealed: string, secret: string, nowMs: number): Promise<{ org: string; token: string } | null>` — returns null on tamper / wrong key / expiry / malformed.
  - `INVITE_COOKIE = "__Host-wh_invite"` (prod) / `"wh_invite"` (dev) via a `inviteCookieName(nodeEnv)` mirroring `sessionCookieName`.
  - `setInviteCookie(payload)`, `readInviteCookie(): Promise<{org,token}|null>`, `clearInviteCookie()` — thin wrappers over `next/headers` `cookies()` + the seal/open (they read the secret + `Date.now()`).

**Crypto model:** derive a 256-bit AES-GCM key via HKDF-SHA256 from the UTF-8 secret, `salt = ""`, `info = "wh-invite-cookie-v1"` (distinct from the session token's HMAC use → no key reuse). Format: `base64url(iv[12] ‖ ciphertext ‖ tag)`; plaintext is `JSON.stringify({ org, token, exp })`.

- [ ] **Step 1: Write the failing test** (`apps/web/src/server/invite-cookie.test.ts`)

```ts
import { describe, expect, it } from "vitest";
import { openInvitePayload, sealInvitePayload } from "./invite-cookie";

const SECRET = "test-secret-abc";
const T0 = 1_000_000;

describe("invite cookie seal/open", () => {
  it("round-trips org + token", async () => {
    const sealed = await sealInvitePayload({ org: "org_1", token: "whinv_AbC-123" }, SECRET, T0);
    expect(await openInvitePayload(sealed, SECRET, T0 + 1000)).toEqual({
      org: "org_1",
      token: "whinv_AbC-123",
    });
  });

  it("rejects a tampered ciphertext", async () => {
    const sealed = await sealInvitePayload({ org: "o", token: "t" }, SECRET, T0);
    const flipped = sealed.slice(0, -2) + (sealed.endsWith("A") ? "B" : "A");
    expect(await openInvitePayload(flipped, SECRET, T0)).toBeNull();
  });

  it("rejects a wrong key", async () => {
    const sealed = await sealInvitePayload({ org: "o", token: "t" }, SECRET, T0);
    expect(await openInvitePayload(sealed, "other-secret", T0)).toBeNull();
  });

  it("rejects an expired payload (>15 min old)", async () => {
    const sealed = await sealInvitePayload({ org: "o", token: "t" }, SECRET, T0);
    expect(await openInvitePayload(sealed, SECRET, T0 + 15 * 60_000 + 1)).toBeNull();
  });

  it("rejects garbage", async () => {
    expect(await openInvitePayload("not-base64url!!", SECRET, T0)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it, verify it fails** — `pnpm --filter @webhook-co/web test invite-cookie` → FAIL.

- [ ] **Step 3: Implement the seal/open core** (`apps/web/src/server/invite-cookie.ts`) — cookie accessors added in Step 3b.

```ts
import "server-only";
import { cookies } from "next/headers";
import { getSessionSecret } from "@/server/env";

const TTL_MS = 15 * 60_000;
const enc = new TextEncoder();
const dec = new TextDecoder();

function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function aesKey(secret: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode("wh-invite-cookie-v1") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function sealInvitePayload(
  payload: { org: string; token: string },
  secret: string,
  nowMs: number,
): Promise<string> {
  const key = await aesKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const pt = enc.encode(JSON.stringify({ ...payload, exp: nowMs + TTL_MS }));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, pt));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return b64urlEncode(out);
}

export async function openInvitePayload(
  sealed: string,
  secret: string,
  nowMs: number,
): Promise<{ org: string; token: string } | null> {
  try {
    const raw = b64urlDecode(sealed);
    if (raw.length < 13) return null;
    const key = await aesKey(secret);
    const iv = raw.subarray(0, 12);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, raw.subarray(12));
    const obj = JSON.parse(dec.decode(pt)) as { org?: unknown; token?: unknown; exp?: unknown };
    if (typeof obj.org !== "string" || typeof obj.token !== "string" || typeof obj.exp !== "number") {
      return null;
    }
    if (nowMs > obj.exp) return null;
    return { org: obj.org, token: obj.token };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run tests, verify pass** — `pnpm --filter @webhook-co/web test invite-cookie` → PASS (5 tests).

- [ ] **Step 3b: Add the cookie accessors** (append to `invite-cookie.ts`) — mirror `sessionCookieOptions`.

```ts
export function inviteCookieName(nodeEnv = process.env.NODE_ENV): string {
  return nodeEnv === "production" ? "__Host-wh_invite" : "wh_invite";
}
const inviteCookieOptions = () =>
  ({ httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/" }) as const;

export async function setInviteCookie(payload: { org: string; token: string }): Promise<void> {
  const sealed = await sealInvitePayload(payload, await getSessionSecret(), Date.now());
  (await cookies()).set(inviteCookieName(), sealed, { ...inviteCookieOptions(), maxAge: 15 * 60 });
}
export async function readInviteCookie(): Promise<{ org: string; token: string } | null> {
  const c = (await cookies()).get(inviteCookieName());
  if (!c) return null;
  return openInvitePayload(c.value, await getSessionSecret(), Date.now());
}
export async function clearInviteCookie(): Promise<void> {
  (await cookies()).delete({ name: inviteCookieName(), ...inviteCookieOptions() });
}
```

- [ ] **Step 5: Commit** — `git add apps/web/src/server/invite-cookie.ts apps/web/src/server/invite-cookie.test.ts && git commit -m "feat(web): encrypted app-origin invite cookie (AES-GCM, HKDF from session secret)"`

---

### Task 3: Auth handoff threads a validated `next`

**Files:**
- Modify: `apps/auth/src/issuer/session-handoff-route.ts` (`SessionHandoffRouteDeps.appCallbackUrl` gains a `next`; `handleSessionHandoff` reads + validates `next`)
- Modify: `apps/auth/src/issuer/session-handoff-deps.ts:60-61` (`appCallbackUrl(ticket, next?)` appends `&next=`)
- Modify: the wiring that constructs the deps (same file / route entry) to pass the app origin into the guard
- Test: `apps/auth/src/issuer/session-handoff-route.test.ts` (extend)

**Interfaces:**
- Consumes: `sanitizeReturnPath` from `@webhook-co/shared`; the app base URL already available to `appCallbackUrl` (it builds `${appBaseUrl}/auth/callback`).
- Produces: `appCallbackUrl(ticket: string, next?: string | null): string` — appends `&next=<once-encoded>` only when `next` is a non-null validated path.

- [ ] **Step 1: Write failing tests** — assert (a) a valid `?next=/invite/accept?org=X` on the handoff URL is reflected into the appCallbackUrl as an encoded `next`; (b) an off-origin `?next=//evil.com` is dropped (appCallbackUrl has no `next`); (c) the not-signed-in bounce still reflects the whole `pathname+search` (including `next`) into `loginUrl`. Use the existing test's deps-injection style.

```ts
// in session-handoff-route.test.ts — sketch of the new cases
it("reflects a valid same-origin next into the app callback url", async () => {
  const appCallbackUrl = vi.fn((t: string, next?: string | null) =>
    `https://app.test/auth/callback?ticket=${t}${next ? `&next=${encodeURIComponent(next)}` : ""}`);
  const res = await handleSessionHandoff(
    depsWith({ appCallbackUrl }),
    new Request("https://auth.test/session/handoff?next=%2Finvite%2Faccept%3Forg%3DX"),
  );
  expect(res.headers.get("location")).toContain("next=");
  expect(appCallbackUrl.mock.calls[0][1]).toBe("/invite/accept?org=X");
});

it("drops an off-origin next", async () => {
  const appCallbackUrl = vi.fn((t: string) => `https://app.test/auth/callback?ticket=${t}`);
  await handleSessionHandoff(
    depsWith({ appCallbackUrl }),
    new Request("https://auth.test/session/handoff?next=%2F%2Fevil.com"),
  );
  expect(appCallbackUrl.mock.calls[0][1] ?? null).toBeNull();
});
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement** — in `handleSessionHandoff`, after minting the ticket:

```ts
const rawNext = new URL(request.url).searchParams.get("next");
const next = sanitizeReturnPath(rawNext, deps.appOrigin); // deps.appOrigin = new URL(APP_BASE_URL).origin
return redirect(deps.appCallbackUrl(ticket, next), { "referrer-policy": "no-referrer" });
```

Add `appOrigin: string` to `SessionHandoffRouteDeps`; in `session-handoff-deps.ts` change `appCallbackUrl` to:

```ts
appCallbackUrl: (ticket, next) =>
  `${appBaseUrl}/auth/callback?ticket=${encodeURIComponent(ticket)}` +
  (next ? `&next=${encodeURIComponent(next)}` : ""),
```

and set `appOrigin: new URL(appBaseUrl).origin`.

- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat(auth): session-handoff threads a validated same-origin next into the app callback"`

---

### Task 4: App `/auth/callback` honors a validated `next`

**Files:**
- Modify: `apps/web/src/app/auth/callback/route.ts:56`
- Test: `apps/web/src/app/auth/callback/route.test.ts` (extend, or create if absent)

**Interfaces:** Consumes `sanitizeReturnPath` from `@webhook-co/shared`.

- [ ] **Step 1: Write failing test** — a successful exchange with `?ticket=X&next=/invite/accept?org=Y` lands on `/invite/accept?org=Y`; with `?next=//evil.com` (or absent) lands on `/`.

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement** — replace the hardcoded landing (`route.ts:56`):

```ts
const next = sanitizeReturnPath(url.searchParams.get("next"), url.origin) ?? "/";
const response = NextResponse.redirect(new URL(next, url.origin));
```

(The cookie set + `no-store` + `no-referrer` headers stay exactly as they are.)

- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat(web): auth callback honors a validated same-origin next (fallback /)"`

---

### Task 5: `/invite/accept` — unauth seals cookie + login-with-`next`; authed reads token from cookie

**Files:**
- Modify: `apps/web/src/app/invite/accept/page.tsx`
- Modify: `apps/web/src/server/session.ts` (add `loginUrlWithReturn(path: string): string` helper — builds `${authBase}/login?redirect=/session/handoff?next=<once-encoded path>`; does NOT change `verifySession`)
- Test: `apps/web/src/app/invite/accept/page.test.tsx` (create) + `apps/web/src/server/session.test.ts` (extend)

**Interfaces:**
- Consumes: `setInviteCookie`, `readInviteCookie` (Task 2); `getSession()` (the non-throwing session read — verify its name in session.ts; if only `verifySession` exists, add a `getSessionOrNull()` that returns null instead of redirecting).
- Produces: `loginUrlWithReturn(path)`.

- [ ] **Step 1: session helper test** (`session.test.ts`) — `loginUrlWithReturn("/invite/accept?org=X")` returns a URL whose `redirect` param is `/session/handoff?next=%2Finvite%2Faccept%3Forg%3DX` (nested app path encoded **once**), and that value matches Better Auth's accepting regex (assert against the regex from Global Constraints, so the footgun is pinned here deterministically):

```ts
const BA_REGEX = /^\/(?!\/|\\|%2f|%5c)[\w\-.\+/@]*(?:\?[\w\-.\+/=&%@]*)?$/;
it("builds a login URL whose redirect passes Better Auth's callbackURL guard", () => {
  const u = new URL(loginUrlWithReturn("/invite/accept?org=X&token=SECRET".replace(/&token=[^&]*/, "")));
  const redirectParam = u.searchParams.get("redirect")!; // "/session/handoff?next=%2Finvite%2Faccept%3Forg%3DX"
  expect(redirectParam.startsWith("/session/handoff?next=")).toBe(true);
  expect(BA_REGEX.test(redirectParam)).toBe(true);
});
```

- [ ] **Step 2: implement `loginUrlWithReturn`** in `session.ts`:

```ts
/** Opt-in login URL that returns to an app path after the handoff. `path` is a relative app path. */
export function loginUrlWithReturn(path: string): string {
  const next = encodeURIComponent(path); // encode ONCE — the nested query becomes %3F%26 etc.
  return `${LOGIN_URL}?redirect=${encodeURIComponent(`/session/handoff?next=${next}`)}`;
}
```

Run `session.test.ts` → PASS.

- [ ] **Step 3: page test** (`invite/accept/page.test.tsx`) — mock the session read + cookie helpers:
  - unauth + `?org=X&token=SECRET` → seals cookie `{org:X, token:SECRET}` AND redirects to `loginUrlWithReturn("/invite/accept?org=X")` (token NOT in the returned path).
  - authed + `?org=X&token=SECRET` → renders the Accept form (existing path), no cookie seal.
  - authed + `?org=X` (no token) + cookie has `{org:X, token:T}` → renders the Accept form.
  - authed + `?org=X` (no token) + no cookie → renders the incomplete-link banner.

- [ ] **Step 4: implement the page** — replace the implicit `verifySession()` bounce with an explicit branch:

```tsx
const session = await getSessionOrNull();
const org = first(sp.org);
const token = first(sp.token);

if (!session) {
  if (org && token) await setInviteCookie({ org, token });   // stash the token app-side only
  redirect(loginUrlWithReturn(org ? `/invite/accept?org=${encodeURIComponent(org)}` : "/invite/accept"));
}

// signed in: token from the URL (existing-user path) or the cookie (returned new-user path)
const cookie = token ? null : await readInviteCookie();
const effectiveToken = token || (cookie && cookie.org === org ? cookie.token : "");
const linkComplete = org !== "" && effectiveToken !== "";
// render Accept form with hidden `org` only; the action reads the token (URL or cookie) — Task 6.
```

Run page tests → PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(web): invite/accept stashes the token in a cookie and returns through login for a new invitee"`

---

### Task 6: `acceptInviteAction` reads the token from the cookie + clears it

**Files:**
- Modify: `apps/web/src/server/invite-actions.ts` (`acceptInviteAction`, lines ~180-234)
- Test: `apps/web/src/server/invite-actions.test.ts` (extend)

**Interfaces:** Consumes `readInviteCookie`, `clearInviteCookie` (Task 2).

- [ ] **Step 1: Write failing tests** — (a) formData has `org` but no `token`, cookie holds `{org, token}` for the same org → `acceptInvite` is called with that token; on success the cookie is cleared and it redirects to `/?invite=accepted` (or the joined dashboard). (b) formData token present → cookie NOT consulted. (c) cookie org ≠ formData org → token from cookie is ignored (treated as invalid).

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement** — near the top of `acceptInviteAction`:

```ts
const orgId = String(formData.get("org") ?? "");
let token = String(formData.get("token") ?? "");
if (!token) {
  const cookie = await readInviteCookie();
  if (cookie && cookie.org === orgId) token = cookie.token;
}
```

After the accept attempt completes (any terminal outcome), `await clearInviteCookie();` before the redirect (a no-op when absent). Keep the rest of the landing logic unchanged.

- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat(web): acceptInviteAction reads the invite token from the cookie and clears it"`

---

### Task 7: End-to-end wiring, footgun check, and full gate

**Files:**
- Verify: `getSessionOrNull` exists (add to `session.ts` if not — a non-throwing variant of `verifySession`, returning `Session | null`, with its own test).
- Test: `apps/web/playwright/*` — add a new-invitee E2E spec IF the Playwright harness can drive auth (otherwise document a manual verification checklist in the PR).

- [ ] **Step 1:** Confirm/add `getSessionOrNull()` (`session.ts`) + a test that a valid cookie returns the session and an absent/invalid cookie returns `null` (NOT a redirect).
- [ ] **Step 2:** Full monorepo gate: `pnpm --filter @webhook-co/shared test`, `pnpm --filter @webhook-co/web test`, `pnpm --filter @webhook-co/auth test`, `pnpm typecheck`, per-package `eslint` on changed files (root `pnpm lint` is noisy from stale worktrees — lint changed files directly).
- [ ] **Step 3:** Manual/e2e verification checklist for the PR (self-verified via the Chrome extension + the reversible prod self-test used for onboarding): brand-new invitee (magic-link AND Google) → returns to `/invite/accept` → Accept → name-only onboarding → team dashboard with the accepted banner; and confirm no `INVALID_CALLBACK_URL` 403 (the encoding footgun) on both providers.
- [ ] **Step 4: Commit** any wiring; open the PR; run `/code-review` + `/security-review` (mandatory).

---

## Self-review

- **Spec coverage:** cookie (T2), returnTo threading (T3, T5), same-origin guard at both hops (T1→T3,T4), token-from-cookie + clear (T6), opt-in verifySession untouched (T5 adds a helper, doesn't change the gate), no migration (none present), encoding footgun pinned (T5 Step 1 regex + T7 Step 3 manual). All spec sections map to a task.
- **Placeholder scan:** none — real code in every code step; the one "sketch"-labelled test block (T3/T6) is illustrative of the injection style already in those suites and is fleshed out at execution.
- **Type consistency:** `sanitizeReturnPath(candidate, origin) → string|null`, `sealInvitePayload/openInvitePayload(..., secret, nowMs)`, `appCallbackUrl(ticket, next?)`, `loginUrlWithReturn(path)`, `readInviteCookie(): {org,token}|null`, `getSessionOrNull(): Session|null` — used consistently across tasks.
