# ADR 0038 — CLI output contract: compact machine JSON, terminal-safe text, locked exit codes

- status: accepted (**D2b** — the scriptable-output half of the output tier; the global-flag foundation +
  `--color`/`--no-color` shipped in D2a/ADR-0037, and `listen --output json` was already NDJSON).
- date: 2026-06-22
- scope: `packages/cli/src/output/format.ts` (`renderJson` → compact single-line), new
  `packages/cli/src/output/safe-text.ts` (`sanitizeControl`), `packages/cli/src/output/render.ts` (every
  server-controlled string routed through `field()`), `packages/cli/src/commands/listen.ts`
  (`formatListenEvent` + the error-frame notice sanitized), `packages/cli/src/commands/whoami.ts` (text
  identity sanitized), `packages/cli/src/output/exit-codes.ts` (the documented map). Tests:
  `src/output/safe-text.test.ts` (new), `src/output/{format,render,exit-codes}.test.ts`,
  `src/commands/{endpoints,whoami,listen}.test.ts`.
- relates: ADR-0009 (CLI foundation), ADR-0037 (D2a global flags + color), ADR-0014 (the live tail whose
  NDJSON this formalises). `internal/build-plans/lane-d-cli.md` §D2. Lane D (`packages/cli`).
- review severity: medium (changes the machine-JSON shape + the text-render path for every read command).
  One fresh-eyes code review (SHIP, NITs only) + one security red-team — the red-team confirmed the
  escape-neutralisation is bypass-free and surfaced **two** completeness gaps (the `whoami` text identity
  and the `listen` error-frame notice still rendered server `z.string()`s raw); **both folded in** before
  this ADR.

## context

`--output json` is documented as the CLI's machine view, but `renderJson` pretty-printed (2-space) — a
multi-line value per result, which is awkward for line-oriented tooling and inconsistent with `listen`,
whose `--output json` already emits one compact JSON object per line (NDJSON). Separately, the text views
(aligned tables + key:value blocks + the live-tail line + the audit line) rendered **server-controlled
strings** — an endpoint name, an event id, a provider label, a dedup key, a content type, an audit-break
detail, and (found in review) the `whoami` identity + a tunnel error-frame's code/message — **raw**. A
hostile value could embed an ANSI / cursor / clear-screen / OSC sequence to forge or hide terminal output,
and a stray newline/tab would break table alignment. Finally, the exit-code map (the scriptable contract a
user's CI branches on) lived only as code with no published, change-guarded shape.

## decision

1. **`--output json` is the compact machine view.** `renderJson(value)` → `JSON.stringify(value)` — one
   JSON value on one line, no indentation. It is line-oriented (consistent with `listen`'s NDJSON), and a
   human who wants it pretty pipes `| jq`. `JSON.stringify` also escapes control bytes (`\uXXXX`), so the
   JSON view is injection-safe **without** the text-view sanitiser. The `{items, nextCursor}` list envelope
   is unchanged in shape (scripts still drive pagination off `nextCursor`); only the whitespace changes.

2. **Terminal-safe text rendering.** New `output/safe-text.ts` `sanitizeControl(s)` replaces every C0 byte
   (`0x00–0x1F`, including ESC `0x1B`, tab, CR, LF), DEL (`0x7F`), and every C1 byte (`0x80–0x9F`, incl. the
   8-bit CSI `0x9B`) with U+FFFD, leaving all printable text (incl. astral code points) intact. It is a
   code-point scan (no regex) to avoid a control char in a regex literal (`no-control-regex`), mirroring
   `output/color.ts`'s by-code ESC handling. Every server-controlled string in the text renderers passes
   through it first (`render.ts` via a `field()` alias; `listen.ts` `formatListenEvent` + the error-frame
   notice; `whoami.ts`'s text identity). Locally-generated tokens (our `colorize` ANSI, formatted dates,
   byte counts) are trusted and bypass it — so our own color survives. An ANSI sequence requires a literal
   ESC or a C1 introducer, both stripped, so there is no multi-byte reconstruction bypass.

3. **Documented + locked exit-code map.** `output/exit-codes.ts` carries the authoritative table in its
   header (generic `0/1/2/3/64` + per-capability `10–16`), and a test locks every numeric value, so a
   renumber that would break a user's CI must be a deliberate, reviewed edit — never an accident.

## consequences

- `wbhk … --output json` pipes cleanly into `jq`/`while read` as one value per line; the list envelope and
  all single-record/`audit` JSON shapes are unchanged except for whitespace (all command JSON tests assert
  via `JSON.parse`, so none broke).
- A malicious webhook (e.g. an endpoint named with an embedded ANSI/clear-screen sequence) can no longer
  hijack the operator's terminal through any `wbhk` text view; the worst case is visible `�` placeholders.
- The raw `events payload` text path is deliberately **left verbatim** (it's the literal captured body, for
  `> file`); the lossless base64 envelope is the safe machine view, and that path is unchanged.
- The exit-code contract is now published and regression-guarded.

## alternatives considered

- **Keep pretty JSON (kubectl/aws idiom).** Rejected for the machine view — compact is line-oriented,
  matches `listen`'s NDJSON, and `| jq` recovers pretty trivially.
- **Sanitise inside the table/block renderer (one place).** Rejected — those helpers also receive our own
  legitimate `colorize` ANSI; sanitising there would strip our color. Wrapping the **raw server fields** at
  their source keeps our generated tokens intact.
- **Strip the control bytes (vs. replace with U+FFFD).** Rejected — replacing keeps a visible marker that
  the field carried hostile bytes (useful for an audit tool) and preserves a predictable 1-column width.
- **A separate per-item NDJSON `list` mode.** Rejected as scope creep — the compact `{items, nextCursor}`
  envelope is the scriptable list contract; `listen` is the per-line stream surface.
