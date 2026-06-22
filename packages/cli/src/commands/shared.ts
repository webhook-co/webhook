import {
  createApiClient,
  ENV_API_URL_VAR,
  resolveApiBaseUrl,
  type ApiClient,
  type Page,
} from "../api-client.js";
import type { AppContext } from "../context.js";
import { NotLoggedInError } from "../errors.js";
import { renderJson, type OutputFormat } from "../output/format.js";

// Shared plumbing for the read commands: build an authenticated client from the stored credential +
// resolved base URL, follow cursor pagination, and emit a list (a table to stdout + a "more results"
// hint to stderr, or the {items, nextCursor} envelope as JSON). Keeping this here means every read
// command resolves auth + the base URL identically (and picks up a sticky stored base URL for free).

/** Resolve the stored credential into a ready API client, or NotLoggedInError when none is stored. */
export async function authedClient(
  ctx: AppContext,
  flags: { apiUrl?: string },
): Promise<ApiClient | NotLoggedInError> {
  const cred = await ctx.store.get();
  if (cred === null) return new NotLoggedInError();
  const baseUrl = resolveApiBaseUrl({
    flag: flags.apiUrl,
    env: ctx.process.env?.[ENV_API_URL_VAR],
    stored: await ctx.store.getApiBaseUrl(),
  });
  return createApiClient({ baseUrl, apiKey: cred.apiKey, fetch: ctx.io.fetch });
}

/** Validate `--limit`: an integer in the server's accepted 1–200 range (a throw → a usage error). */
export function parseLimit(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 200) {
    throw new Error("limit must be an integer between 1 and 200");
  }
  return n;
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
