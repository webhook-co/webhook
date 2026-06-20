# ADR 0026 — the consent + device-verification pages (deliberate-grant) and the C→E consent payload

- status: accepted
- date: 2026-06-20
- scope: `apps/auth` (`/consent`, `/device`)
- relates: [ADR-0021](0021-opennext-cloudflare-workers-app-and-auth.md) (the co-owned `apps/auth` on
  OpenNext); [ADR-0022](0022-auth-dashboard-component-set.md) (the primitives these screens use);
  [ADR-0024](0024-option-b-token-issuance-core.md) (Lane C's `/token` issuance core — its `ConsentProps`
  is what consent _records_); the Lane E build-plan (slice E4). Pairs with Lane C's A3 (`/authorize`) + A4
  (device flow). Internal auth ADR-0010.

## context

OAuth/device authorization needs two human-facing screens on `auth.`: a **consent** screen (review and
approve/deny an access request) and a **device-verification** screen (enter the user-code shown on a
device). Lane C owns the `/authorize` + device endpoints (A3/A4); Lane E owns the pages. E4 builds them
**mock-first** (the UI is fully real; only the network seam is a swappable mock) so they're buildable and
reviewable before Lane C's endpoints exist — E8 wires the live client with no UI change. This ADR also
**freezes the C→E payload contract** (U-3) so both lanes build to one shape.

## decision — deliberate-grant model

**Consent is an explicit, reviewable approval — never silent, never a per-scope checklist.**

- **Consent is shown for every flow, including loopback PKCE.** A localhost redirect is not implicit
  consent; the user still sees the request and approves/denies it. There is no auto-approve path in v1.
- **The screen is a trust summary, not a configuration form.** It shows _who/what_ is asking (the client,
  and the device name for a device flow), _where from_ (IP + best-effort location), _which org_, the
  _requested scopes_ (read-only summary), and _when_ the grant expires. The user makes one whole-grant
  decision: **Authorize** or **Deny**. No per-scope toggles — scope is decided by the requesting client and
  narrowed server-side by the issuer ([ADR-0024](0024-option-b-token-issuance-core.md)); a checklist here
  would imply a control the user doesn't actually have.
- **The device screen forgives input.** The user-code is entered case-insensitively, with or without the
  dash/spaces, and canonicalized to `XXXX-XXXX` before submit; a malformed code is rejected client-side
  before any network call. On success the user continues to the same consent screen.
- **Both screens are single-column AuthShell** (no marketing visual) — focused task surfaces, not entry
  points. States handled: idle, in-flight, approved/denied (consent), verified/invalid-or-expired (device),
  and a generic decision/verification error.

## the C→E payload contract (frozen)

Lane C's `/authorize` resolves the pending authorization and **SSRs a `ConsentRequest`** into `/consent`;
the user's choice is POSTed back as a `ConsentDecision`; the device screen POSTs a `DeviceCodeSubmission`.
E4 ships these as the seam types in `apps/auth` (mocked); when E8/Lane C wire it live, promote them to
`@webhook-co/contract` as the shared definition.

```ts
// C → E : SSR'd into /consent (resolved from the authorization-request id)
interface ConsentRequest {
  requestId: string;              // opaque id of this pending authorization; echoed with the decision
  csrfToken: string;              // single-use, bound to this request + the auth session; echoed back
  flow: "pkce_loopback" | "device_code";
  client: { id: string; name: string };          // display name, never just the opaque client_id
  device?: { name: string };                      // present for the device-code flow
  org: { id: string; name: string };              // the consenting user's active org
  origin: { ip: string; location: string | null };// trust signal; location is best-effort
  scopes: string[];                               // requested capability scopes (read-only summary)
  audience: string;                               // resource the resulting token is bound to
  expiresAt: string;                              // ISO 8601 — grant/key expiry if approved
}

// E → C : POSTed when the user decides
interface ConsentDecision { requestId: string; csrfToken: string; decision: "approve" | "deny"; }

// E → C : POSTed from /device to verify the user-code (canonical "XXXX-XXXX")
interface DeviceCodeSubmission { userCode: string; }
```

**Mapping to what consent records.** On `approve`, Lane C maps the request to the `ConsentProps` it stashes
in the provider grant ([ADR-0024](0024-option-b-token-issuance-core.md)): `org.id → orgId`,
`scopes → scopes`, `audience → audience`, `device → device`; `userId` comes from the **auth session**, never
the page. The richer display fields (`client.name`, `org.name`, `origin`, `expiresAt`) are screen-only.

**Obligations on Lane C (A3/A4).** Resolve `requestId` server-side (an absent/expired request renders the
expired state, not the form); issue + verify the single-use `csrfToken` bound to the session; supply a
human `client.name` and best-effort `origin.location`; on a valid `DeviceCodeSubmission`, advance to the
same `/consent`. The audience and scope authority stays server-side — the screen only displays them.

## consequences

- E4 is fully buildable/reviewable against the fixture; E8 swaps the mock `ConsentActions`/`DeviceActions`
  + the page's request source for Lane C's live client/SSR, no UI change.
- The pages are static in mock-first (the fixture is build-time constant); E8 makes `/consent` dynamic when
  it reads the per-request payload.
- Security posture is Lane C's: the `csrfToken` (state-changing POST defense), the session-derived `userId`,
  the single-use request, and the server-side scope/audience authority all live on C's endpoints — the
  screen is a display + a decision POST, never an authority.
