# ADR 0046 — CLI OAuth credential model (the D8 storage foundation)

- status: accepted (**D8a** — the credential-union schema + redaction + read-path + keychain
  serialization. The OAuth wire client (DCR/PKCE/token/refresh/device/revoke) is D8b; the login/logout
  commands + the browser/device flows are D8c).
- date: 2026-06-22
- scope: `packages/cli/src/config/schema.ts` (`StoredCredential` union + `CONFIG_VERSION` 2→3 + migration
  + `isOAuthCredential`/`credentialAccessToken`), `packages/cli/src/output/format.ts` (total
  `redactCredential`), `packages/cli/src/config/keychain-store.ts` (JSON-serialized credential + legacy
  fallback), read-path threading in `commands/{shared,whoami,listen,replay}.ts`. Tests across
  `schema`/`format`/`keychain-store`/`whoami`/`context`.
- relates: ADR-0009 (credential foundation), ADR-0039/0040 (config versioning + profiles), ADR-0057/0045
  (the keychain this serializes into). Consumes the frozen Lane C OAuth contract (see the cli-oauth-contract
  memory + `~/.claude/plans/cozy-greeting-cupcake.md` §D8). `internal/build-plans/lane-d-cli.md` §D8. Lane D.
- review severity: high (credential storage + the refresh-token-secrecy invariant). One AUTH red-team + one
  code review — both SHIP, no findings.

## context

D8 makes the CLI an OAuth client. Before the wire + the login flows, the stored credential must be able to
REPRESENT an OAuth credential (a short-lived `whk_` access key + a rotating `rtk_` refresh handle + the
metadata to refresh it), without breaking the existing api-key credential, and with an airtight guarantee
that the refresh token is never displayed. This slice is that foundation, kept dormant (no flow writes an
OAuth credential yet) so it's reviewable in isolation.

## decision

1. **`StoredCredential` becomes a union.** `z.union([ {apiKey} , {oauth:{accessKey, refreshToken,
   authMethod, expiresAt, audience, clientId}} ])`. The variants have disjoint keys, so the union is
   unambiguous; the legacy `{apiKey}` shape stays valid. `CONFIG_VERSION` 2→3 with a pure version-bump
   migration (a v2 config's `{apiKey}` creds validate as v3); a v3-with-oauth config read by an older v2
   CLI fails the version literal → cold-start, never a misparse. Helpers: `isOAuthCredential` (`"oauth" in
   cred`) and `credentialAccessToken` (the `whk_` bearer from either variant).

2. **The refresh token is never displayable.** `redactCredential` is total over the union and masks ONLY
   the access token (`whk_****`); it never reads `oauth.refreshToken`. Every output path (`whoami` text +
   json, the future `login --json`/`doctor`) routes through it, so the `rtk_` handle is structurally
   unreachable from stdout/stderr.

3. **The keychain stores the whole credential as JSON.** The OAuth variant is a structured object (not a
   bare key), so the keychain backend now stores `JSON.stringify(cred)` and parses + schema-validates on
   read. A legacy bare-string entry (pre-OAuth) reads back as `{apiKey}`; a parseable-but-invalid blob →
   null (cold-start). The 0600 file backend already serialized the full credential, so the refresh token
   gets the same at-rest protection as the api key.

4. **Read paths use `credentialAccessToken`.** Every site that sent `cred.apiKey` as the bearer
   (`authedClient`, `whoami`, `listen` ×2, `replay`) now uses `credentialAccessToken(cred)` — so an OAuth
   credential's access key is used transparently. (The api-key `login` write path is unchanged; OAuth
   login is D8c.)

## consequences

- The credential store can hold an OAuth credential; D8b/D8c can mint, persist, and refresh one with no
  further schema work.
- A pre-OAuth config (or keychain entry) upgrades losslessly; nothing user-visible changes in D8a (no flow
  writes an OAuth credential yet).
- The refresh-token-secrecy invariant is established + tested before any flow can produce a refresh token.

## alternatives considered

- **A discriminated union with a `type` tag.** Rejected — the two variants already have disjoint keys
  (`apiKey` vs `oauth`); a tag would be redundant and would break the legacy `{apiKey}` shape.
- **Store only the access key in the keychain; refresh in the file.** Rejected — splitting one credential
  across two stores complicates refresh + logout; the whole credential lives in one place (keychain, or
  the 0600 file as fallback).
- **No CONFIG_VERSION bump (the union is backward-compatible).** Rejected — bumping to v3 makes an older
  CLI fail-closed on a new OAuth config rather than silently mishandle it.
