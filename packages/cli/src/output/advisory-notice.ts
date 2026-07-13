// The `wbhk` update notice.
//
// The version advisory is SERVER-DRIVEN: the CLI sends its version in the User-Agent and the API answers on
// a response we already asked for. So there is no npm poll, no background request, nothing to slow a command
// down, and nothing to hang on a plane.
//
// Rendered as a box because a bare line gets lost in a wall of table output — and written to STDERR by the
// caller, never stdout, so `wbhk endpoints list | jq` stays byte-clean.

import { colorize, stripAnsi } from "./color.js";

/** The advisory the API reported (mirrors the SDK shape; the CLI renders its own, prettier copy). */
export interface CliAdvisory {
  readonly deprecated: boolean;
  readonly current: string;
  readonly latest: string;
  readonly message: string;
}

const V = "│";

const ADVISORY = /^(update-available|deprecated);\s*current=([\w.+-]+);\s*latest=([\w.+-]+)$/;

/**
 * Parse the server's `x-webhook-advisory`. Null for absent OR malformed input — the server is not the CLI's
 * parser, and a garbled header must never break a command. The worst it can do is say nothing.
 */
export function parseAdvisoryHeader(
  header: string | null | undefined,
  deprecation: string | null | undefined,
): CliAdvisory | null {
  if (!header) return null;
  const match = ADVISORY.exec(header.trim());
  if (match === null) return null;
  const [, kind, current, latest] = match as unknown as [string, string, string, string];
  return {
    deprecated: kind === "deprecated" || deprecation === "true",
    current,
    latest,
    message: "",
  };
}

/**
 * A boxed update notice.
 *
 * Width is measured on the VISIBLE text (stripAnsi). ANSI escapes have length but no width, so measuring
 * the raw string would pad the colored rows short and the box would come out ragged in a real terminal —
 * the same trap the table renderer already documents.
 */
export function renderAdvisoryNotice(advisory: CliAdvisory, color: boolean): string {
  const title = advisory.deprecated
    ? colorize("This version is no longer supported", "red", color)
    : colorize("Update available", "yellow", color);

  const versions = `${colorize(advisory.current, "dim", color)} → ${colorize(advisory.latest, "green", color)}`;
  const action = `Run ${colorize("wbhk upgrade", "green", color)} to update.`;

  const rows = [`${title}   ${versions}`, action];
  const inner = Math.max(...rows.map((row) => stripAnsi(row).length));

  const border = (text: string): string => colorize(text, "dim", color);
  const line = (left: string, right: string): string =>
    border(`${left}${"─".repeat(inner + 2)}${right}`);
  const row = (text: string): string =>
    `${border(V)} ${text}${" ".repeat(inner - stripAnsi(text).length)} ${border(V)}`;

  return [line("╭", "╮"), ...rows.map(row), line("╰", "╯")].join("\n");
}
