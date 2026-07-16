# ADR-0121: Linking is same-email only — `allowDifferentEmails` off

- Status: accepted
- Date: 2026-07-16
- Supersedes in part: the `allowDifferentEmails: true` row of
  [ADR-0118](0118-account-linking-policy-and-identity-uniqueness.md). The rest of that ADR — the pinned block,
  every other option, and the `(providerId, accountId)` unique index — stands unchanged.

## Context

ADR-0118 pinned `allowDifferentEmails: true` on this rationale:

> Let a *signed-in* user link a provider whose email differs from their current one — required so a user who
> changes their email can re-link Google/GitHub. Safe: `/link-social` needs the user's own session, and
> implicit sign-in linking stays same-email regardless.

Every factual clause there is true. What it omitted is that the capability it enables **has no surface**. The
flag is read at exactly three sites in better-auth 1.6.23, all on the *explicit* link path:

| Read site | Path |
| --- | --- |
| `dist/api/routes/callback.mjs:98` | `/link-social`'s OAuth-redirect callback (the `if (link)` branch) |
| `dist/api/routes/account.mjs:151` | `/link-social`'s id-token variant |
| `dist/plugins/generic-oauth/routes.mjs:235` | the generic-oauth plugin — **not installed** (our plugins are captcha + magicLink) |

`handleOAuthUserInfo` — the implicit sign-in linking path — **never reads it**. Its gate is only
`isTrustedProvider`/`emailVerified`/`requireLocalEmailVerified`/`enabled`/`disableImplicitLinking`. Sign-in
linking is same-email by *construction*, not by flag: `findOAuthUser` locates the user **by email**
(`dist/db/internal-adapter.mjs:437-443`), so a match is structural.

So `allowDifferentEmails: true` widened exactly one thing: a signed-in user hand-crafting a
`POST /api/auth/link-social` could attach a provider identity whose email differs from their account. There is
no UI for it, and the "re-link after an email change" case it was reserved for was never reachable — that user
had no button to press either way.

Founder decision (2026-07-16): **same-email-only linking is the intended policy**, and the config should say
so rather than hold a door open for a surface that does not exist.

## Decision

**Set `allowDifferentEmails: false`.** Linking — implicit *and* explicit — now requires the provider's email
to match the account's.

Nothing about the sign-in experience changes: that path never consulted the flag. What changes is that the
one API-only route to a different-email link is closed, and the pinned block now describes a single coherent
policy instead of two.

## Consequences

- **The config matches the behaviour we actually want**, on every path. Previously the block enforced
  same-email on the path users take and permitted different-email on a path only an API caller could take —
  a divergence that read as deliberate but was really just an unexercised option.
- **The deferred Connect-button slice loses most of its point.** Its value was the different-email case
  (`internal/build-plans/connect-social-login-slice.md`); same-email linking already happens by itself on
  sign-in. If Connect is ever revisited, this ADR is the thing to reopen first.
- **The email-change re-link edge is now closed rather than theoretically open.** Concretely: a user whose
  account email moves from `a@x` to `b@y`, and who then *unlinks* their `a@x` Google, cannot re-link it. Note
  this was already the practical situation — there was no surface to re-link through — and note it does **not**
  affect anyone who simply changes their email: the existing link survives, because sign-in resolves an
  account by `(providerId, accountId)`, never by email.
- **A user whose provider email differs still gets a separate account, silently.** Signing in with a
  non-matching Google doesn't link and doesn't error — `findOAuthUser` finds nobody, and with
  `disableSignUp: false` better-auth creates a new user with its own personal org. This ADR neither causes nor
  fixes that; it is pre-existing and tracked separately. It is the one real cost of same-email-only, and it is
  a UX trap worth solving on its own terms.
- The regression test in `auth.test.ts` (`toEqual`, exact) pins the new value; a silent flip back fails CI.
