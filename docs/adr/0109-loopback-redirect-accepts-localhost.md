# ADR 0109 — DCR loopback redirects accept `localhost` (not only `127.0.0.1`/`::1`)

- status: accepted
- date: 2026-07-11
- scope: `apps/auth` (`dcr.ts`, the consent-completion bounce)
- supersedes: the narrow "loopback = `127.0.0.1`/`::1` literal only, never `localhost`" rule from the A3
  open-DCR hardening (referenced in `dcr.ts` as ADR-0026 / internal ADR-0010)
- relates: [ADR-0026](0026-consent-and-device-pages.md) (deliberate-grant consent), RFC 8252 §7.3/§8.3,
  RFC 6761 §6.3, the MCP authorization spec

## context

The v1 open-DCR policy accepted only `http://127.0.0.1` / `http://[::1]` redirect URIs and **rejected
`localhost`**, because the first-party CLI — the only OAuth client at the time — used the IP literal, and
`localhost` was judged DNS/hosts-hijackable (RFC 8252 §8.3 prefers IP literals). A registered `localhost`
redirect also flows through `openLoopbackRedirect` into the `GET /consent/complete` **server-issued 302**,
so the concern was: on a machine where `localhost` resolves somewhere other than loopback (a planted hosts
entry, a split-horizon corporate resolver, a rogue local process), the 302 could hand the OAuth
authorization code to a non-loopback destination.

But **real MCP clients use `http://localhost`**: Claude Code, VS Code (Copilot), and Continue register a
`localhost` loopback callback via DCR. Rejecting it is exactly why "add `mcp.webhook.co`" failed in Claude
Code with *"every redirect_uri must be an http loopback (127.0.0.1 or ::1)"*. Supporting these clients at
all **requires** accepting `localhost`.

## decision

**Accept `localhost` as a loopback redirect** (alongside `127.0.0.0/8` and `::1`), for both DCR
registration and the consent-completion bounce. This matches RFC 8252's loopback definition, the MCP
spec's "redirect URIs MUST be localhost or HTTPS", the provider's own `isLoopbackUri`, and every major
OAuth provider (Google, GitHub, Okta all accept `http://localhost:PORT` for native apps).

The residual hijack the old rule guarded against does not hold in the actual threat model:

- **The consent redirect is followed by a browser, and modern browsers hard-map `localhost` to loopback
  without consulting DNS or the hosts file** (RFC 6761 §6.3 "let localhost be localhost"; Chrome/Firefox/
  Safari all resolve the literal name `localhost` to `127.0.0.1`/`::1` locally). So the server-302 to
  `http://localhost:PORT` reaches the user's own loopback — the `localhost → attacker-IP` remap is not
  reachable from the browser that follows the 302.
- **PKCE (S256, mandatory) binds the code to the initiating client's verifier.** Even if a code were
  delivered elsewhere, it can't be exchanged without the verifier, which never leaves the legitimate
  client.
- **Consent is shown for every authorization** (ADR-0026, no auto-approve), so no silent grant.

Loopback redirects carry no cross-origin phishing surface regardless: the code can only reach the user's
own machine. (Remote `https` is separately restricted to an allowlist of known MCP-vendor hosts.)

## consequences

- Claude Code / VS Code / Continue (and any RFC 8252 `localhost` client) complete OAuth.
- We deliberately do **not** rewrite `localhost` → `127.0.0.1` in the 302 Location: the browser already
  hard-maps it, and a rewrite would *break* a client whose loopback server binds only the IPv6 stack
  (`::1`) — the browser's dual-stack `localhost` resolution is more compatible than a forced IPv4 literal.
- If a future non-browser agent that resolves `localhost` via the OS is ever driven through the consent
  302, revisit — but that agent is the client on its own machine, not a phished third party.
