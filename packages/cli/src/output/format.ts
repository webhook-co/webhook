import { redactSecret } from "@webhook-co/shared";

import type { StoredCredential } from "../config/schema.js";
import { CliError } from "../errors.js";

// The output-formatting seam. Commands return structured data; this renders it as text or
// JSON so every surface (and CI) gets the same shape. JSON output makes the CLI scriptable
// and mirrors what MCP/API return (capability parity). Color is threaded for future ANSI.
export type OutputFormat = "text" | "json";

export function resolveFormat(flag: OutputFormat | undefined): OutputFormat {
  return flag ?? "text";
}

// `--output json` is the MACHINE view: one compact JSON value on a single line (no pretty-printing).
// That keeps it line-oriented and consistent with `listen`'s NDJSON event stream, so a tool can read a
// value per line; a human who wants it pretty pipes `| jq`. (JSON.stringify also escapes control bytes,
// so this view is injection-safe without the text renderers' sanitizeControl.)
export function renderJson(value: unknown): string {
  return JSON.stringify(value);
}

/** A non-reversible display handle — reuses the shared loggable-view redactor. */
export function redactCredential(cred: StoredCredential): string {
  return redactSecret(cred.apiKey);
}

/**
 * One voice-compliant line for an error: what happened (and, for CliErrors, why/what next).
 * Never a stack trace or ANSI codes. (Color is reserved for a future styled renderer.)
 */
export function formatCliError(error: unknown, _opts: { color: boolean }): string {
  if (error instanceof CliError) return error.userMessage;
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * The "unknown command" message — on-voice, with a did-you-mean when stricli offers a close match,
 * else a pointer at `--help`. `corrections` is stricli's own edit-distance shortlist for the input,
 * already backtick-quoted for display (so we join them, never re-wrap).
 */
export function formatUnknownCommand(args: {
  input: string;
  corrections: readonly string[];
}): string {
  const base = `unknown command \`${args.input}\``;
  if (args.corrections.length > 0) {
    const suggestion = args.corrections.join(" or ");
    return `${base} — did you mean ${suggestion}? run \`wbhk --help\` for the full list.`;
  }
  return `${base} — run \`wbhk --help\` to see the available commands.`;
}
