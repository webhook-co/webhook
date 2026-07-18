import { MAX_INLINE_BODY_BYTES, parseSince } from "@webhook-co/shared";

import {
  createApiClient,
  ENV_API_URL_VAR,
  resolveApiBaseUrl,
  type ApiClient,
  type Page,
} from "../api-client.js";
import type { Org } from "../config/schema.js";
import type { AppContext } from "../context.js";
import { NotLoggedInError } from "../errors.js";
import { parseAdvisoryHeader } from "../output/advisory-notice.js";
import { writeAdvisory } from "../state/advisory-store.js";
import {
  announceActiveProfile,
  resolveEffectiveOrg,
  resolveRequestProfile,
  type GlobalFlags,
} from "../global-flags.js";
import { bindAuth } from "../oauth/auth-binding.js";
import { renderJson, type OutputFormat } from "../output/format.js";

// Shared plumbing for the read commands: build an authenticated client from the stored credential +
// resolved base URL, follow cursor pagination, and emit a list (a table to stdout + a "more results"
// hint to stderr, or the {items, nextCursor} envelope as JSON). Keeping this here means every read
// command resolves auth + the base URL identically (and picks up a sticky stored base URL for free).

/** The resolved authed request context: the ready client plus the (non-secret) profile + EFFECTIVE org it
 *  targets — the `--org`/`WBHK_ORG` selection, else the profile's persisted org metadata — resolved once
 *  here so a command (e.g. `events open`, for the dashboard slug) reuses it without re-reading the store.
 *  `org` is undefined for an env (WBHK_API_KEY) credential (its real org is server-side, not in the local
 *  store) OR when neither a selector nor any persisted org exists (an older login). `envCredential` lets a
 *  consumer that still needs the env org's slug fetch it from whoami instead of trusting the local store. */
export interface AuthedContext {
  client: ApiClient;
  profile: string;
  org?: Org;
  envCredential: boolean;
}

/**
 * Resolve the stored credential into a ready API client PLUS the profile/org it resolved, or
 * NotLoggedInError when none is stored. `authedClient` is the thin "just the client" wrapper; commands
 * that also need the bound profile/org (to read local org metadata, say) use this directly. The active
 * profile (`--profile`/`WBHK_PROFILE`/persisted/default) + org selector are resolved here — the single
 * place that runs — so every command picks up the selected profile's credential + sticky base URL
 * identically, and the profile/org banner is announced exactly once.
 */
export async function resolveAuthedContext(
  ctx: AppContext,
  flags: GlobalFlags,
): Promise<AuthedContext | NotLoggedInError> {
  // The authed request path — the ONLY place the org selector runs (a stale WBHK_ORG errors HERE with an
  // actionable message, never on a display/discovery command). Precedence + conflict rules in
  // resolveRequestProfile; a bad `--org`/`WBHK_ORG` throws OrgNotFound/Ambiguous, disagreeing flags conflict.
  const { profile, org: selectorOrg } = await resolveRequestProfile(ctx, flags);
  announceActiveProfile(ctx, profile);
  const cred = await ctx.store.get(profile);
  if (cred === null) return new NotLoggedInError();
  // Resolve the EFFECTIVE org once — env-guarded (an env key's org isn't in the local store). Consumed by
  // callers that need it LOCALLY (e.g. `events open` / listen's `o` key build the dashboard deep-link's
  // slug from it), not announced: the org is fixed by the credential, so echoing it on every command was
  // noise rather than information. `wbhk whoami` is where you ask what org you're bound to.
  const effective = await resolveEffectiveOrg(ctx, profile, selectorOrg);
  const { org, envCredential } = effective;
  const baseUrl = resolveApiBaseUrl({
    flag: flags.apiUrl,
    env: ctx.process.env?.[ENV_API_URL_VAR],
    stored: await ctx.store.getApiBaseUrl(profile),
  });
  // Resolve the bearer (proactively refreshing an OAuth credential) + the reactive 401 refresh hook.
  const { bearer, refreshAuth } = await bindAuth({
    cred,
    profile,
    store: ctx.store,
    fetch: ctx.io.fetch,
    env: ctx.process.env,
  });
  const client = createApiClient({
    baseUrl,
    apiKey: bearer,
    fetch: ctx.io.fetch,
    refreshAuth,
    // Cache whatever version advisory the API rides back, so a later run — including `wbhk -v`, which makes
    // no request at all — can show it without the CLI ever polling npm. Fire-and-forget; a nudge must never
    // slow down or fail a command.
    onAdvisory: (header, deprecation) => {
      const advisory = parseAdvisoryHeader(header, deprecation);
      if (advisory !== null) void writeAdvisory(ctx.configDir, advisory);
    },
  });
  return { client, profile, org, envCredential };
}

/**
 * Resolve the stored credential into a ready API client, or NotLoggedInError when none is stored. The
 * active profile (`--profile`/`WBHK_PROFILE`/persisted/default) is resolved here, so every read command
 * picks up the selected profile's credential + sticky base URL without threading it itself.
 */
export async function authedClient(
  ctx: AppContext,
  flags: GlobalFlags,
): Promise<ApiClient | NotLoggedInError> {
  const resolved = await resolveAuthedContext(ctx, flags);
  return resolved instanceof NotLoggedInError ? resolved : resolved.client;
}

/** Validate `--limit`: an integer in the server's accepted 1–200 range (a throw → a usage error). */
export function parseLimit(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 200) {
    throw new Error("limit must be an integer between 1 and 200");
  }
  return n;
}

/** Validate `--max-body-bytes`: a positive integer up to the server's inline-body cap (a throw → usage error). */
export function parseMaxBodyBytes(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_INLINE_BODY_BYTES) {
    throw new Error(`max-body-bytes must be an integer between 1 and ${MAX_INLINE_BODY_BYTES}`);
  }
  return n;
}

/**
 * Parse a date/time flag (any value `new Date()` accepts — RFC3339 is the documented form) and
 * normalize to an ISO-8601 string for the query. Rejects an unparseable value at the CLI (a usage
 * error) rather than passing garbage to the server.
 */
export function parseIsoDate(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`invalid date: ${value} (use an ISO-8601 / RFC3339 timestamp)`);
  }
  return d.toISOString();
}

/**
 * Parse `--after`, which — unlike `--before` — also accepts the API's relative received-after grammar
 * (`7d` / `24h` / `30m` / `now` / `beginning`). A relative token is FORWARDED UNCHANGED: `receivedAfter`
 * resolves it server-side (the same `parseSince` grammar the CLI shares), and trying to parse it as an
 * instant here would reject it (`new Date("7d")` is `Invalid Date`). Anything else is treated as an instant
 * and normalized to ISO via `parseIsoDate` — preserving the lenient date parsing (`2026-07-09`) the strict
 * RFC3339 grammar would otherwise refuse. True garbage still throws a usage error.
 */
export function parseReceivedAfter(value: string): string {
  const parsed = parseSince(value);
  if (parsed.kind === "now" || parsed.kind === "beginning" || parsed.kind === "relative") {
    return value;
  }
  return parseIsoDate(value);
}

/**
 * One server page by default; with `all`, follow `nextCursor` to exhaustion, accumulating into a
 * single result (the keyset cursor strictly advances, so the walk terminates). `cursor` seeds the
 * first page either way.
 */
export async function collectPages<T>(
  fetchPage: (cursor: string | undefined) => Promise<Page<T>>,
  opts: { cursor?: string; all: boolean },
): Promise<{ items: T[]; nextCursor: string | null }> {
  if (!opts.all) {
    const page = await fetchPage(opts.cursor);
    return { items: [...page.items], nextCursor: page.nextCursor };
  }
  const items: T[] = [];
  let cursor = opts.cursor;
  for (;;) {
    const page = await fetchPage(cursor);
    items.push(...page.items);
    // Stop at the end — or defensively if the cursor fails to advance: a server that returned a
    // stable non-null nextCursor would otherwise loop forever (the keyset cursor must strictly move).
    if (page.nextCursor === null || page.nextCursor === cursor) break;
    cursor = page.nextCursor;
  }
  return { items, nextCursor: null };
}

/**
 * Emit a paginated list. JSON mode writes the `{items, nextCursor}` envelope verbatim (so a script can
 * drive pagination off `nextCursor`). Text mode writes an aligned table to stdout and, when another
 * page exists, a one-line hint to STDERR — keeping stdout clean for piping.
 */
export function emitList<T>(
  ctx: AppContext,
  result: { items: T[]; nextCursor: string | null },
  opts: {
    format: OutputFormat;
    color: boolean;
    renderTable: (items: readonly T[], color: boolean) => string;
    empty: string;
  },
): void {
  if (opts.format === "json") {
    ctx.process.stdout.write(
      `${renderJson({ items: result.items, nextCursor: result.nextCursor })}\n`,
    );
    return;
  }
  ctx.process.stdout.write(
    result.items.length === 0
      ? `${opts.empty}\n`
      : `${opts.renderTable(result.items, opts.color)}\n`,
  );
  if (result.nextCursor !== null) {
    ctx.process.stderr.write("more results — rerun with --all, or --cursor <token>\n");
  }
}
