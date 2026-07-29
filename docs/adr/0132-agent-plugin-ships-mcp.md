# ADR 0132 — the agent plugin ships skills AND the MCP server

- status: accepted
- date: 2026-07-29
- supersedes: [ADR-0131](0131-agent-plugin-skills-only.md)
- scope: `plugin/webhook-co`, `apps/mcp`, `scripts/plugin-manifest-guard.mjs`,
  `scripts/gen-wrangler-prod.mjs`, `.github/workflows/deploy.yml`

## context

ADR-0131 shipped the plugin as skills-only. It rested on two loads, and both are gone.

**The first was factually wrong.** ADR-0131 states that the submission types are mutually exclusive —
that a skills-only upload carrying `mcpServers` is rejected as `mcp_configuration_excluded`. That is
not true:

- **8 of the 180 curated plugins ship skills AND `mcpServers`**, including `github`, `linear`,
  `notion`, `figma`, `cloudflare` and OpenAI's own `openai-developers`.
- The plugin.json spec's own sample manifest carries `skills`, `hooks`, `mcpServers` and `apps`
  together, and documents `mcpServers` as an ordinary optional field.
- The string `mcp_configuration_excluded` appears **nowhere** in the shipped validator, the spec, or
  the plugin-creator tooling.

The claim was never verified against the corpus that was sitting on disk. It is recorded here rather
than quietly deleted, because a guard was written to enforce it — `plugin-manifest-guard` asserted
that `mcpServers` must be ABSENT — and a wrong invariant with a passing test looks exactly like a
right one.

**The second was a judgement call, and the founder has made it the other way.** ADR-0131 argued that
our tool responses fail the "remove personal data, auth secrets, debug payloads and internal
identifiers" requirement, because `endpoints.create`/`rotate`/`revealIngestUrl` return the plaintext
ingest URL, `events.get` returns raw inbound headers, and `triggers.wait` returns raw payload bodies.

The ruling (2026-07-29) is that this classification was wrong, and none of these are personal data or
auth secrets in the sense the requirement means:

- The **ingest URL** is the org's own URL, returned to the authenticated owner over an OAuth-protected
  channel. It is "always shown" by product design (ADR-0101), not a secret we failed to redact.
- **Raw inbound headers and bodies** are the customer's own captured traffic. Inspecting them
  unmodified **is** the product; `packages/shared/src/redaction.ts` already records that they are
  stored unscrubbed deliberately. Scrubbing them would not make the plugin safer, it would make it
  useless.

Nothing about these endpoints changes. What changes is that we stop treating a deliberate product
property as a compliance defect.

## decision

Ship the plugin as **skills + one remote MCP server**, and keep both.

- `plugin.json` declares `mcpServers: "./.mcp.json"`; that file names exactly one server,
  `type: "http"`, `https://mcp.webhook.co/mcp`, `oauth_resource: https://mcp.webhook.co`.
- **Keep the skill.** It is the only part that works with no account and no OAuth, so it is what stops
  install-to-value being a signup flow. The manifest guard fails a plugin with zero skills for exactly
  this reason, even though the MCP server alone would satisfy the directory's runtime-surface rule.
- **Serve domain verification from `mcp.webhook.co`.** OpenAI fetches
  `/.well-known/openai-apps-challenge` at the origin root of the MCP host or a **parent** of it.
  `www.webhook.co` does not qualify — it is not a parent of `mcp.` — and the apex 301s to `www`. This
  host is the only viable one. There is no DNS-based alternative, so the MCP-Registry escape hatch
  (which we used there) does not exist here.
- The token is an **optional deploy-injected `var`**, not a Secrets Store binding: the endpoint's
  entire job is to serve it publicly to an unauthenticated fetcher, so confidentiality would be a
  fiction. It grants nothing; it proves only that whoever set it controls this host. Unset or blank →
  the route **404s**, which is the correct posture whenever no submission is in flight.
- The listing declares `["Interactive", "Read", "Write"]`. It previously declared `Interactive` alone
  while the server exposed `endpoints.create`/`delete`/`rotate`, `events.delete` and
  `triggers.create`/`revoke` — an **understated** capability set, which is the dangerous direction: it
  means consenting to something narrower than what gets installed.

## consequences

- `apps` and `hooks` stay excluded. `apps` points at ChatGPT Apps SDK custom UI we do not ship;
  `hooks` is rejected by the shipped validator and 0 of 180 curated plugins declare it.
- **One token per host.** The challenge endpoint may return only one plugin's token, so a second
  submission against this same host would collide here rather than compose.
- **Reviewer demo credentials are now a live blocker, and are not solved by this ADR.** An MCP-backed
  review needs credentials that complete each test with no MFA, no SMS and no email confirmation. Our
  auth runtime is **social + magic-link only** — `apps/auth/src/runtime/auth.ts` serves Google, GitHub
  and magic link, and its own comment records "no password signup". All three fail the requirement:
  the social providers mean handing over a third-party account (and their new-device checks are
  precisely the MFA/email confirmation being excluded), and magic link *is* email confirmation. Every
  OAuth-backed MCP plugin in the corpus is backed by a product that has a password login; we do not.
  Closing this needs a product decision, not a config change, and it is deliberately not made here.
- A guard that encoded the false exclusivity rule has been inverted, and its tests with it. The
  lesson worth keeping: the corpus of 180 real manifests was available locally the whole time, and one
  scan would have falsified the claim before it became an invariant.
