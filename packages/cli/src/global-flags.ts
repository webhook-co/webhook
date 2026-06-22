import { resolveFormat, type OutputFormat } from "./output/format.js";

// The flags every command accepts — the output format, the API base-URL override, and the color
// override. Defined once and spread into each command's `parameters.flags` so the surface stays
// consistent (and shell completions read one source). stricli has no built-in global flags, so this is
// the user-land shared-spec pattern; the values are resolved per-handler (buildContext runs before argv
// is parsed, so it can resolve env/TTY defaults but never a flag value).
//
// `color` is a single OPTIONAL boolean: stricli auto-generates its negation, so it surfaces as both
// `--color` (force on) and `--no-color` (force off); unset (`undefined`) falls back to the env/TTY-
// resolved default. (A second `noColor` flag would collide with that auto-generated negation.)

/** The parsed value of the global flags — every command's flags interface extends this. */
export interface GlobalFlags {
  output: OutputFormat;
  apiUrl?: string;
  color?: boolean;
}

/** The stricli flag spec for the global flags — spread into each command's `parameters.flags`. */
export const globalFlags = {
  output: {
    kind: "enum",
    values: ["text", "json"],
    brief: "output format",
    default: "text",
  },
  apiUrl: {
    kind: "parsed",
    parse: (value: string): string => value,
    brief: "override the API base URL",
    optional: true,
  },
  color: {
    kind: "boolean",
    optional: true,
    brief: "force colored output (--no-color to disable; auto-detected by default)",
  },
} as const;

/** The resolved globals a handler reads: the output format + the effective color. */
export interface ResolvedGlobals {
  readonly format: OutputFormat;
  readonly color: boolean;
}

/** `--color`/`--no-color` (the parsed `color`) wins when set; otherwise the env/TTY-resolved default. */
export function resolveColorFlag(flags: { readonly color?: boolean }, envColor: boolean): boolean {
  return flags.color ?? envColor;
}

/** Resolve the global flags against the context — the flag overrides the env/TTY-resolved color. */
export function resolveGlobals(
  ctx: { readonly colorEnabled: boolean },
  flags: GlobalFlags,
): ResolvedGlobals {
  return {
    format: resolveFormat(flags.output),
    color: resolveColorFlag(flags, ctx.colorEnabled),
  };
}
