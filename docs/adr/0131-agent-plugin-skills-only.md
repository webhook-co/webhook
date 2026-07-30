# ADR 0131 — the agent plugin ships skills only, and does not reference the MCP server

> **Superseded by [ADR-0132](0132-agent-plugin-ships-mcp.md) (2026-07-29).** Two corrections, kept here
> rather than edited away. First, the mutual-exclusivity premise below is **factually wrong**: 8 of the
> 180 curated plugins ship skills and `mcpServers` together, the spec's own sample manifest carries
> both, and `mcp_configuration_excluded` appears nowhere in the shipped tooling. Second, the
> data-handling argument was a judgement the founder has since ruled the other way — the ingest URL and
> raw captured headers/bodies are not personal data or auth secrets in the sense that requirement means.
> The reasoning below is preserved because a guard was built to enforce the wrong invariant, and a wrong
> invariant with a passing test is indistinguishable from a right one.

- status: superseded by [ADR-0132](0132-agent-plugin-ships-mcp.md)
- date: 2026-07-28
- scope: `plugin/webhook-co`, `.agents/plugins/marketplace.json`, `scripts/plugin-manifest-guard.mjs`

## context

OpenAI's plugin directory is shared by ChatGPT and Codex: one submission lists in both. A plugin may
contain skills, an MCP server, or both — but the submission TYPES are mutually exclusive. A
skills-only upload carrying `mcpServers` or `apps` is rejected (`mcp_configuration_excluded`,
`app_configuration_excluded`), and choosing "with MCP" activates every MCP gate at once: domain
verification, reviewer demo credentials, tool annotations, a content security policy, a tool scan,
and the four listing URLs becoming mandatory.

We already have `mcp.webhook.co`, so shipping it was the obvious move. Three findings said otherwise.

**Our MCP tool responses do not meet the requirement we would be attesting to.** The submission
checklist requires removing personal data, auth secrets, debug payloads and internal identifiers from
tool responses. `endpoints.create`/`rotate`/`revealIngestUrl` return the full plaintext ingest URL —
a live bearer credential. `events.get` returns raw unscrubbed inbound headers including
`authorization` and `cookie`. `triggers.wait` returns raw third-party payload bodies with
`includeBody` defaulting to true. The first two are not oversights: `packages/shared/src/redaction.ts`
records that headers and bodies are stored unscrubbed deliberately, because inspecting them **is** the
product. So this is a genuine tension between our value proposition and the directory's rules, not a
bug to fix on the way to submission.

**The demo-credential requirement is a security design problem.** Review requires credentials that
work with no MFA, no SMS and no email confirmation. Password login does not exist at runtime
(`apps/auth/src/runtime/auth.ts` has no `emailAndPassword`), and there is no MFA anywhere, so the only
mechanism that satisfies it is a scoped, expiring `whk_` API key in a purpose-built org. That is
provisionable, but it is a live credential handed to a third party, and skills-only needs none of it.

**The zero-auth value is real but narrower than "144 providers".** A closed-book experiment scored a
frontier model at 100% on Stripe/GitHub/Shopify/Slack and 67% per-provider on a hand-picked footgun
set — every error silent, and confidence uncorrelated with correctness. So the defensible payload is
the diagnosis and the handful of schemes where recall is confidently wrong, not registry breadth.

## decision

Ship **skills-only**, named `webhook-co`, with one skill and no `mcpServers`, no `apps`, no `hooks`.

- **Link-first.** The skill's primary path is `webhook.co/verify`, which runs the real engine
  client-side on a static export with no endpoint behind it. It works on every surface, needs no
  install, cannot rot, and sends traffic to a page we control. `@webhook-co/webhooks-spec` on npm is
  the optional offline path. We ship **no vendored bundle**: duplicating our crypto onto other
  people's machines is a worse supply-chain posture for no gain.
- **No hooks.** Hooks can execute arbitrary shell commands, 0 of the 180 curated plugins declare
  them, and the validator that ships with Codex rejects the manifest key outright even though the
  prose docs document it.
- **`webhook-co`, not `webhook`.** `name` is immutable across updates and namespaces every skill, so
  it is a one-way door. The guidelines warn against single-word dictionary terms; `webhook` is
  available but not worth spending on a first version this small.
- **Not under `packages/`.** That path is in the `pull_request` `paths:` filter of three deploy
  workflows, so a markdown-and-JSON change there would trigger three Cloudflare deploy dry-runs.

## consequences

- We do **not** learn whether our inspection wedge is listable. That question is deferred, not
  answered, and it needs the MCP path. Reopen this ADR to answer it.
- `scripts/plugin-manifest-guard.mjs` pins the skills-only invariants, so adding an MCP reference —
  the most natural "improvement" to this plugin — fails the build rather than silently changing the
  submission class.
- The guard also pins two caps that no amount of imitating shipped plugins would reveal:
  `displayName` and `shortDescription` are capped at **30** for final submission while package
  validation allows 80/240, and 163 of the 180 curated plugins exceed 30.
- The count sweep in `published-counts.test.ts` now walks `plugin/` as well as `packages/`, because
  the manifest and SKILL.md state a registry size and neither is a file this repo deploys.
- Nothing is submitted. Submission is outward-facing and stays a founder decision.
