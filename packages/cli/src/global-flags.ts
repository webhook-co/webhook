import { ENV_API_KEY_VAR } from "./config/env-store.js";
import { DEFAULT_PROFILE, type Org } from "./config/schema.js";
import {
  AmbiguousOrgError,
  InvalidProfileNameError,
  OrgNotFoundError,
  OrgProfileConflictError,
  OrgSelectorWithEnvKeyError,
} from "./errors.js";
import { resolveFormat, type OutputFormat } from "./output/format.js";
import { sanitizeControl } from "./output/safe-text.js";

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

/** Env var that selects the target profile BY ITS BOUND ORG SLUG (below `--org`, above `--profile`). */
export const WBHK_ORG_VAR = "WBHK_ORG";

// Profile names key an in-memory object map; these collide with a plain object's reserved keys (a
// `__proto__` write silently no-ops; `constructor`/`prototype` shadow), so they're refused outright.
const RESERVED_PROFILE_NAMES: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/** True for a profile name that collides with a JS object's reserved keys (unsafe as a map key). */
export function isReservedProfileName(name: string): boolean {
  return RESERVED_PROFILE_NAMES.has(name);
}

/** The parsed value of the global flags — every command's flags interface extends this. */
export interface GlobalFlags {
  output: OutputFormat;
  apiUrl?: string;
  color?: boolean;
  profile?: string;
  org?: string;
}

/** The flag type for display/diagnostic/local commands — GlobalFlags WITHOUT `--org` (see displayFlags). */
export type DisplayFlags = Omit<GlobalFlags, "org">;

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
  org: {
    kind: "parsed",
    parse: (value: string): string => value,
    brief:
      "target the local credential bound to this org slug (overrides WBHK_ORG; with --profile it must name that profile's org)",
    optional: true,
  },
} as const;

/**
 * The flag subset for DISPLAY / DIAGNOSTIC / LOCAL commands — everything EXCEPT `--org`. The org selector is
 * a DATA-command concept: it chooses which org's DATA a request acts on. Commands that don't act on org data
 * — `whoami` (reports the active credential's identity), `logout` (erases local state + revokes that
 * profile's OWN token), and the local-discovery commands (`org` / `profile` / `doctor`) — must NOT advertise
 * `--org`, or it becomes a flag that's parsed but can't be honored: either silently ignored (wrong-org) or,
 * if force-fitted through the strict selector, made to hard-fail on an ambient `WBHK_ORG`/`WBHK_API_KEY` and
 * lose their recovery role. They resolve PROFILE-ONLY (display-safe, ambient-`WBHK_ORG`-proof); point them at
 * a specific login with `--profile`. Data commands + `login` keep the full `globalFlags` (with `--org`).
 */
export const displayFlags = {
  output: globalFlags.output,
  apiUrl: globalFlags.apiUrl,
  color: globalFlags.color,
  profile: globalFlags.profile,
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

/** Where the effective profile came from (for `profile current`'s human-facing source label). PROFILE-only
 *  — the org selector is NOT part of this display/discovery path (see resolveRequestProfile). */
export type ProfileSource = "--profile" | "WBHK_PROFILE" | "active profile" | "default";

type ProfileResolverCtx = {
  readonly process: { readonly env?: Readonly<Record<string, string | undefined>> };
  // list/getOrg are the seams the org selector scans; optional so the many inline in-memory test fakes (and
  // the display-only callers, which never touch the selector) need not implement them.
  readonly store: {
    getActiveProfile?(): Promise<string | undefined>;
    list?(): Promise<string[]>;
    getOrg?(profile: string): Promise<Org | undefined>;
  };
};

/** Treat an empty flag/env string as unset. */
function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value !== "" ? value : undefined;
}

/** The one reserved-name guard point for a resolved profile (from any source). */
function guardReservedProfile(name: string): void {
  if (isReservedProfileName(name)) throw new InvalidProfileNameError(name);
}

/** True when `WBHK_API_KEY` is set — the env backend then serves the credential for EVERY profile (top read
 *  precedence), so no profile's stored org metadata applies to the active credential. */
export function hasEnvApiKey(ctx: {
  readonly process: { readonly env?: Readonly<Record<string, string | undefined>> };
}): boolean {
  return nonEmpty(ctx.process.env?.[ENV_API_KEY_VAR]) !== undefined;
}

/** A ctx whose store can report the credential's source (env vs keychain/file). */
type EnvCredentialCtx = {
  readonly process: { readonly env?: Readonly<Record<string, string | undefined>> };
  readonly store: {
    getWithSource?(profile?: string): Promise<{ readonly source: string } | null>;
  };
};

/**
 * Whether the active credential comes from the ENV backend (`WBHK_API_KEY`) rather than a stored profile.
 * The env key bypasses profiles entirely — it has top read precedence and carries NO local org metadata —
 * so the org SELECTOR and the "targeting org" BANNER (both profile-metadata based) must be suppressed for
 * it. The single source of truth for that guard, reused by whoami / authedClient / listen / replay.
 */
export async function isEnvCredential(ctx: EnvCredentialCtx, profile: string): Promise<boolean> {
  if (hasEnvApiKey(ctx)) return true;
  const resolved = ctx.store.getWithSource ? await ctx.store.getWithSource(profile) : null;
  return resolved?.source === "env";
}

/**
 * The DISPLAY-SAFE profile resolver: `--profile` › `WBHK_PROFILE` › the persisted active profile ›
 * "default" (an empty flag/env value is treated as unset). PROFILE-ONLY by design — it does NOT read
 * `WBHK_ORG`, never runs the org selector, and NEVER throws (not even on a reserved name). This is what the
 * display/discovery commands (`org list/current`, `profile list/current`, `doctor`, `whoami`) resolve
 * through, so a stale/typo'd `WBHK_ORG` can never brick them — the org selector lives only on the authed
 * request path (resolveRequestProfile). The single source of truth for profile precedence, so those
 * commands never disagree.
 */
export async function resolveActiveProfile(
  ctx: ProfileResolverCtx,
  flags: { readonly profile?: string },
): Promise<{ readonly name: string; readonly source: ProfileSource }> {
  const profileFlag = nonEmpty(flags.profile);
  if (profileFlag !== undefined) return { name: profileFlag, source: "--profile" };
  const env = nonEmpty(ctx.process.env?.[WBHK_PROFILE_VAR]);
  if (env !== undefined) return { name: env, source: "WBHK_PROFILE" };
  const persisted = await ctx.store.getActiveProfile?.();
  if (persisted !== undefined) return { name: persisted, source: "active profile" };
  return { name: DEFAULT_PROFILE, source: "default" };
}

/**
 * Resolve the active profile name for a command's store calls, applying the reserved-name guard. Profile-
 * only (no org selector) — `login` and the display/discovery commands resolve through here. Throws only on
 * a reserved object-key name.
 */
export async function resolveProfile(
  ctx: ProfileResolverCtx,
  flags: { readonly profile?: string },
): Promise<string> {
  const { name } = await resolveActiveProfile(ctx, flags);
  guardReservedProfile(name);
  return name;
}

/**
 * STRICT org→profile resolution for an EXPLICIT slug: scan EVERY profile's stored org (case-insensitive;
 * slugs are lowercase) for a match. Zero matches → OrgNotFoundError; multiple (the same org under two
 * profiles/envs) → AmbiguousOrgError. NEVER reads an ambient env var and NEVER falls through to a default
 * — the whole point is that targeting the wrong org is unrepresentable. Purely local (the org is captured
 * at login). Shared by `wbhk org use` (its positional) and the authed request path (its `--org`/`WBHK_ORG`).
 */
export async function resolveOrgSlugToProfile(
  ctx: ProfileResolverCtx,
  slug: string,
): Promise<{ readonly profile: string; readonly org: Org }> {
  // Trim once here so EVERY selector entry point (--org flag, WBHK_ORG env, `org use` positional) treats a
  // whitespace/newline-padded value — common from `$(…)` command substitution or a `.env` line — the same:
  // it matches the org, rather than throwing a confusing "no local credential" for an org that exists.
  const wanted = slug.trim().toLowerCase();
  const profiles = ctx.store.list ? await ctx.store.list() : [];
  const matches: { profile: string; org: Org }[] = [];
  for (const profile of profiles) {
    const org = await ctx.store.getOrg?.(profile);
    if (org !== undefined && org.slug.toLowerCase() === wanted) matches.push({ profile, org });
  }
  if (matches.length === 0) throw new OrgNotFoundError(slug);
  if (matches.length > 1) {
    throw new AmbiguousOrgError(
      slug,
      matches.map((m) => m.profile),
    );
  }
  return matches[0]!; // length === 1 here (guarded above)
}

/** The profile an authed request will bind, plus the org that selected it (when an org selector was used). */
export interface ResolvedRequestProfile {
  readonly profile: string;
  /** The bound org — present only when an `--org`/`WBHK_ORG` selector resolved the profile. */
  readonly org?: Org;
}

/**
 * The AUTHED-PATH profile resolver — the ONLY place the org selector lives, used exclusively to bind a
 * credential for an API call (authedClient / listen / replay). Corrected precedence, with env vars WEAKER
 * than explicit flags so an ambient `WBHK_ORG` can never override an explicit `--profile`:
 *
 *   `--org` FLAG (strict) › `--profile` FLAG › `WBHK_ORG` env (strict) › `WBHK_PROFILE` env › active › default
 *
 *   • `--org` FLAG: strict — resolves to the matching local profile or THROWS (explicit intent). A
 *     disagreeing explicit `--profile` FLAG alongside it is an OrgProfileConflictError.
 *   • `--profile` FLAG: beats an ambient `WBHK_ORG` — the named profile wins and `WBHK_ORG` is NOT read
 *     (no conflict), so `--profile staging` always works even with `WBHK_ORG=acme` exported.
 *   • `WBHK_ORG` env (only when NEITHER flag is set): strict — resolves or throws. Safe because
 *     display/discovery + login are selector-exempt, so a stale value is always recoverable via
 *     `wbhk org list`; an authed command failing with "no local credential for org …" is the correct,
 *     actionable error (mirrors AWS_PROFILE). A CONFLICT is raised ONLY from two disagreeing FLAGS, never
 *     from an ambient env var.
 */
export async function resolveRequestProfile(
  ctx: ProfileResolverCtx,
  flags: { readonly profile?: string; readonly org?: string },
): Promise<ResolvedRequestProfile> {
  const orgFlag = nonEmpty(flags.org);
  const profileFlag = nonEmpty(flags.profile);

  // `WBHK_API_KEY` short-circuits the org selector: the env key IS the credential (top read precedence) and
  // is bound to a fixed server-side org, so the local org scan cannot route to it. Checked BEFORE any scan/
  // throw so a stale `WBHK_ORG` doesn't surface as a spurious OrgNotFound. An EXPLICIT org selector alongside
  // the env key is refused (targeting the env key's possibly-different org would be a silent wrong-org);
  // otherwise the env key is used regardless, so we just resolve the profile-only name (for base-URL/banner).
  if (hasEnvApiKey(ctx)) {
    // Only an EXPLICIT `--org` flag is refused — the user asked to target an org the env key can't route to.
    // An ambient `WBHK_ORG` is IGNORED (weak), not fatal: leftover env vars must never brick every authed
    // command, and an explicit `--profile` still resolves normally (it only affects base-URL/banner here,
    // since the env key serves the credential regardless).
    if (orgFlag !== undefined) throw new OrgSelectorWithEnvKeyError();
    const { name } = await resolveActiveProfile(ctx, { profile: profileFlag });
    guardReservedProfile(name);
    return { profile: name };
  }

  if (orgFlag !== undefined) {
    if (profileFlag !== undefined) {
      // Both given: `--profile` names WHICH login, `--org` asserts its org. Verify the NAMED profile is bound
      // to that org — a direct check, NOT the all-profiles slug scan, so this ALSO disambiguates when the org
      // is bound under two profiles (the user already picked one). Only a genuine disagreement is an error.
      const wanted = orgFlag.trim().toLowerCase();
      const org = await ctx.store.getOrg?.(profileFlag);
      if (org === undefined || org.slug.toLowerCase() !== wanted) {
        throw new OrgProfileConflictError(orgFlag, profileFlag, org?.slug);
      }
      guardReservedProfile(profileFlag);
      return { profile: profileFlag, org };
    }
    const { profile, org } = await resolveOrgSlugToProfile(ctx, orgFlag);
    guardReservedProfile(profile);
    return { profile, org };
  }
  if (profileFlag !== undefined) {
    // An explicit `--profile` beats an ambient `WBHK_ORG` — do NOT read the env selector, do NOT conflict.
    guardReservedProfile(profileFlag);
    return { profile: profileFlag };
  }
  const orgEnv = nonEmpty(ctx.process.env?.[WBHK_ORG_VAR]);
  if (orgEnv !== undefined) {
    const { profile, org } = await resolveOrgSlugToProfile(ctx, orgEnv);
    guardReservedProfile(profile);
    return { profile, org };
  }
  // No org selector at all → the profile-only fallback (WBHK_PROFILE › active › default).
  const { name } = await resolveActiveProfile(ctx, {});
  guardReservedProfile(name);
  return { profile: name };
}

/**
 * Print a one-line stderr banner naming the active profile when it isn't the default — so a command run
 * against a non-default profile (e.g. staging/prod) never surprises. Stays OFF stdout so pipes stay clean,
 * and silent for the default profile (the common case). The name is sanitized (it's config-controlled).
 */
export function announceActiveProfile(
  ctx: { readonly process: { readonly stderr: { write(s: string): void } } },
  profile: string,
): void {
  if (profile === DEFAULT_PROFILE) return;
  ctx.process.stderr.write(`using profile: ${sanitizeControl(profile)}\n`);
}

/**
 * Print a one-line stderr banner naming the ORG a command is about to target — so a mutating command never
 * silently hits an org the user didn't expect (the token=org invariant made visible). Stays OFF stdout so
 * pipes stay clean; slug + name are config-controlled, so both are sanitized. Called centrally once the
 * profile's bound org is known (see `authedClient`).
 */
export function announceActiveOrg(
  ctx: { readonly process: { readonly stderr: { write(s: string): void } } },
  org: Org,
): void {
  ctx.process.stderr.write(
    `targeting org: ${sanitizeControl(org.slug)} (${sanitizeControl(org.name)})\n`,
  );
}

/**
 * The single place every credential-binding command echoes its target org — so the "targeting org" banner
 * and the credential actually used can never disagree. Two rules, applied uniformly (was copy-pasted across
 * authedClient / listen / replay / logout, which risked one path drifting and announcing the wrong org):
 *   1. NEVER announce for an env (WBHK_API_KEY) credential — its real org is server-determined, so the local
 *      profile's stored org does not describe it (mirrors whoami's env guard).
 *   2. Otherwise announce the selector-resolved org, else the profile's stored org (nothing if neither).
 */
export function announceRequestOrg(
  ctx: { readonly process: { readonly stderr: { write(s: string): void } } },
  resolved: { org?: Org; envCredential: boolean },
): void {
  // Takes the ALREADY-resolved org + env-ness (from resolveEffectiveOrg) so it re-derives nothing — no
  // second isEnvCredential probe, no second store read per command. Env creds don't announce (their real
  // org is server-side); otherwise announce the resolved org when present.
  if (resolved.envCredential) return;
  if (resolved.org !== undefined) announceActiveOrg(ctx, resolved.org);
}

/**
 * The org a credential-binding command should treat as its target for LOCAL display / deep-linking (e.g.
 * the dashboard event URL's slug): the selector-resolved org, else the profile's persisted org — but NEVER
 * the local store's org for an env (WBHK_API_KEY) credential, whose real org is server-determined, so the
 * local profile's stored org does NOT describe it (same guard as {@link announceRequestOrg} and whoami;
 * without it, an env key would build a wrong-org deep-link from an unrelated login's stored org). Also
 * reports whether the credential is an env key, so a caller that still needs the env org's slug knows it
 * must ask whoami rather than the (untrusted-for-env) local store. A MISSING config yields `org: undefined`
 * (a fresh install), but a CORRUPT or insecure-permission config is left to throw its fail-loud, on-voice
 * ConfigError (exit USAGE) — masking that behind `undefined` would tell the user to "run whoami" instead of
 * "fix your config", hiding the real, actionable fault.
 */
export async function resolveEffectiveOrg(
  ctx: EnvCredentialCtx & {
    readonly store: { getOrg(profile: string): Promise<Org | undefined> };
  },
  profile: string,
  selectorOrg?: Org,
): Promise<{ org?: Org; envCredential: boolean }> {
  if (await isEnvCredential(ctx, profile)) return { envCredential: true };
  if (selectorOrg) return { org: selectorOrg, envCredential: false };
  return { org: await ctx.store.getOrg(profile), envCredential: false };
}
