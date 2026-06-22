import { DEFAULT_PROFILE } from "./config/schema.js";
import { InvalidProfileNameError } from "./errors.js";
import { resolveFormat, type OutputFormat } from "./output/format.js";

// The flags every command accepts — the output format, the API base-URL override, the color override,
// and the profile selector. Defined once and spread into each command's `parameters.flags` so the
// surface stays consistent (and shell completions read one source). stricli has no built-in global
// flags, so this is the user-land shared-spec pattern; the values are resolved per-handler (buildContext
// runs before argv is parsed, so it can resolve env/TTY defaults but never a flag value).
//
// `color` is a single OPTIONAL boolean: stricli auto-generates its negation, so it surfaces as both
// `--color` (force on) and `--no-color` (force off); unset (`undefined`) falls back to the env/TTY-
// resolved default. (A second `noColor` flag would collide with that auto-generated negation.)

/** Env var that selects the active profile (below `--profile`, above the persisted active profile). */
export const WBHK_PROFILE_VAR = "WBHK_PROFILE";

// Profile names key an in-memory object map; these collide with a plain object's reserved keys (a
// `__proto__` write silently no-ops; `constructor`/`prototype` shadow), so they're refused outright.
const RESERVED_PROFILE_NAMES: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/** The parsed value of the global flags — every command's flags interface extends this. */
export interface GlobalFlags {
  output: OutputFormat;
  apiUrl?: string;
  color?: boolean;
  profile?: string;
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
  profile: {
    kind: "parsed",
    parse: (value: string): string => value,
    brief: "use a named profile (overrides WBHK_PROFILE and the persisted active profile)",
    optional: true,
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

/**
 * Resolve the active profile: `--profile` › `WBHK_PROFILE` › the persisted active profile › "default".
 * Async (unlike resolveGlobals) because the persisted fallback is a store read; an empty `--profile`/env
 * value is treated as unset. Kept here (not in the sync resolveGlobals) so a handler resolves it once
 * and threads it into its store calls — `authedClient` does this internally for the read commands.
 */
export async function resolveProfile(
  ctx: {
    readonly process: { readonly env?: Readonly<Record<string, string | undefined>> };
    readonly store: { getActiveProfile?(): Promise<string | undefined> };
  },
  flags: { readonly profile?: string },
): Promise<string> {
  let name: string;
  if (flags.profile !== undefined && flags.profile !== "") {
    name = flags.profile;
  } else {
    const env = ctx.process.env?.[WBHK_PROFILE_VAR];
    name =
      env !== undefined && env !== ""
        ? env
        : ((await ctx.store.getActiveProfile?.()) ?? DEFAULT_PROFILE);
  }
  // Guard every source (flag/env/persisted) against reserved object keys, from one place.
  if (RESERVED_PROFILE_NAMES.has(name)) throw new InvalidProfileNameError(name);
  return name;
}
