# 13. CLI read-command UX: rendering, pagination, and a sticky API base URL

Date: 2026-06-15

## Status

Accepted. Builds on [0009](0009-cli-foundation.md) (CLI foundation), [0011](0011-read-capabilities-surface.md)
(the read-capabilities surface), and [0012](0012-cli-auth-and-identity-endpoint.md) (CLI auth + the
api-client). Lifts the per-profile `apiBaseUrl` deferral recorded in 0012.

## Context

Slice 10 makes the five read capabilities real `wbhk` commands — `endpoints list` / `endpoints get`,
`events list` / `events get`, and `audit verify` — on top of the Slice-9 api-client. This is the CLI's
first list/table output and its first pagination, and it forces three decisions that will set the house
style for every future read surface: how human output is rendered, how cursor pagination is exposed,
and whether the API base URL is sticky. No new server work — the REST endpoints shipped in Slice 8.2.

We surveyed how mature developer CLIs handle these (svix, gh, kubectl, aws, stripe, fly, hookdeck, and
clig.dev). The headline findings: every CLI that renders a *table* shows status as a **word**, never a
raw boolean (only the JSON-dumping tools, e.g. svix, surface `disabled: true`); the gold standard
(`gh`) switches table→TSV based on TTY, while `aws`/`svix` instead make the format an explicit flag;
relative timestamps and id-truncation are common but both need state we don't have cheaply (a clock
seam / a reliable stdout-TTY signal).

## Decision

### 1. Rendering — two explicit modes; tables with status *words*

- **`--output text` (humans) vs `--output json` (machines)** are two **explicit** modes. We do *not*
  adopt `gh`'s implicit TTY→TSV auto-switch: we already provide an explicit machine mode, and explicit
  is simpler, predictable, and fully node-testable. `--output json` emits the contract shape verbatim
  (`{items, nextCursor}` for lists; the entity for `get`; the discriminated union for `audit verify`).
- **Lists render as an aligned table** with **UPPERCASE** headers and a two-space gutter (the
  kubectl/gh idiom). A small dependency-free `renderTable` measures **visible** width (ANSI stripped)
  so a colored cell stays aligned.
- **Status is a colored word, not a boolean**: endpoints `active` / `paused` (our own field's noun,
  not svix's `disabled`); events `verified` / `unverified`; a null provider renders as `—`.
- **Full UUIDs + absolute timestamps in text.** Because we don't auto-switch to full-when-piped, ids
  must always be shown in full so they stay copy-pasteable into `… get <id>`; and a webhook/compliance
  tool should show exact times. Relative timestamps and id-truncation are deferred (they need a clock
  seam / a stdout-TTY signal).
- **`get` renders a key:value block** (the `whoami` idiom); `events get` summarizes verification as
  `verified (scheme)` / `unverified (reason)`, full fidelity in JSON.
- **Color is minimal and gated on the resolved `colorEnabled`** (TTY- + NO_COLOR-aware), applied only
  to status tokens and the audit result.

### 2. Pagination — `--limit` / `--all` / `--cursor`, cursor in the payload

`--limit <1..200>` (omitted ⇒ the server default). Default is **one server page**; `--all` follows
`nextCursor` to exhaustion; `--cursor <token>` is the advanced/scripting escape hatch (our cursor is an
opaque HMAC blob, so it's not the primary human UX). When more results exist and `--all` was not given,
text mode prints a one-line hint to **stderr** so stdout stays clean (clig.dev). JSON mode passes
`{items, nextCursor}` through verbatim so a script reads `.nextCursor` and re-invokes with `--cursor`
(the `aws` model; `gh`'s cursor-less JSON is explicitly not our model here).

### 3. Sticky per-profile `apiBaseUrl`

The credential store now surfaces `Profile.apiBaseUrl` (added additively: `getApiBaseUrl` /
`setApiBaseUrl` on the store + backends; the file backend reads/writes it, the env backend does not).
Base-URL precedence is `--api-url` › `WBHK_API_URL` › **stored profile** › default. `login` persists
the base URL **only** when `--api-url` is explicitly passed on a persisted (non-env) login, storing the
normalized value. The stored value is **re-validated on every read** through the same https/no-query
guard, so a hand-edited config can't downgrade the live key to plaintext or redirect it (the Slice-9
security guarantee, applied to the persisted path; a bad stored value fails closed).

### 4. `audit verify` exit code

The call returns HTTP 200 even when the chain is broken, so a detected break is **not** an API error.
A break is signaled with a dedicated non-zero exit, **`EXIT.AUDIT_BREAK` (3)**, so a cron/CI run alerts,
while the result is still printed to stdout in both modes. An intact chain exits 0.

## Consequences

- Read output is consistent and scriptable: `--output json` is the stable machine contract; text is the
  human view. The table renderer + `colorize` are reusable by future read surfaces.
- Self-host/dev users set their API once (`login --api-url …` or `WBHK_API_URL`) and every command
  targets it; the re-validate-on-read rule keeps the persisted path as safe as the flag path.
- Deferred (tracked, not regressions): relative timestamps + id-truncation (need a clock seam /
  stdout-TTY signal), and TTY-driven auto-switching of the output format.
- **Human-UI checkpoint:** the rendered tables, the `get` blocks, the audit line, status colors, and the
  pagination-hint copy are visual and must be eyeballed on a real TTY before release — automated tests
  inject fakes and assert the no-color path.

## Sources

svix CLI (JSON output; `--iterator`), gh (`tableprinter` TTY-vs-TSV; `--limit`), kubectl (UPPERCASE
headers; STATUS word; AGE), aws (`--output table`; `NextToken` in the payload), stripe (cursor +
`--limit`), fly/hookdeck (status words; `--limit`/`--next`), and clig.dev (TTY heuristic; NO_COLOR;
keep machine streams clean).
