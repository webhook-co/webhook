import { buildCommand } from "@stricli/core";
import {
  DEDUP_MODES,
  DedupConfigSchema,
  DEFAULT_DEDUP_WINDOW_SECONDS,
  PROVIDERS,
  type DedupConfig,
  type DedupMode,
  type Provider,
} from "@webhook-co/shared";

import type { AppContext } from "../context.js";
import { ConfirmationError, MissingInputError, NotLoggedInError } from "../errors.js";
import { globalFlags, resolveGlobals, type GlobalFlags } from "../global-flags.js";
import { renderJson } from "../output/format.js";
import {
  renderAddedProviderSecret,
  renderCreatedEndpoint,
  renderDeletedEndpoint,
  renderEndpoint,
  renderEndpointsTable,
  renderProviderSecretsTable,
  renderRevokedProviderSecret,
} from "../output/render.js";
import { authedClient, collectPages, emitList, parseLimit } from "./shared.js";

// `wbhk endpoints list` / `wbhk endpoints get <id>` — read views over the org's endpoints. Both reuse
// the Slice-9 api-client (Bearer + the shared output schema). List paginates (one page, `--all`, or a
// `--cursor`); get prints a single record as a key:value block. `--output json` is the machine view.

interface ListFlags extends GlobalFlags {
  limit?: number;
  cursor?: string;
  all: boolean;
  name?: string;
}

type GetFlags = GlobalFlags;

export const endpointsListCommand = buildCommand<ListFlags, [], AppContext>({
  async func(this: AppContext, flags) {
    const client = await authedClient(this, flags);
    if (client instanceof NotLoggedInError) return client;
    const { format, color } = resolveGlobals(this, flags);
    const result = await collectPages(
      (cursor) => client.endpointsList({ cursor, limit: flags.limit, name: flags.name }),
      { cursor: flags.cursor, all: flags.all },
    );
    emitList(this, result, {
      format,
      color,
      renderTable: renderEndpointsTable,
      empty: "no endpoints.",
    });
  },
  parameters: {
    flags: {
      ...globalFlags,
      limit: {
        kind: "parsed",
        parse: parseLimit,
        brief: "max results per page (1–200)",
        optional: true,
      },
      cursor: {
        kind: "parsed",
        parse: (value: string) => value,
        brief: "resume from a nextCursor token (advanced)",
        optional: true,
      },
      all: {
        kind: "boolean",
        brief: "fetch every page (follow the cursor to the end)",
        default: false,
      },
      name: {
        kind: "parsed",
        parse: (value: string) => value,
        brief: "filter by name (case-insensitive substring)",
        optional: true,
      },
    },
  },
  docs: { brief: "list your endpoints" },
});

export const endpointsGetCommand = buildCommand<GetFlags, [string], AppContext>({
  async func(this: AppContext, flags, endpointId) {
    const client = await authedClient(this, flags);
    if (client instanceof NotLoggedInError) return client;
    const { format, color } = resolveGlobals(this, flags);
    const endpoint = await client.endpointsGet(endpointId);
    this.process.stdout.write(
      format === "json" ? `${renderJson(endpoint)}\n` : `${renderEndpoint(endpoint, color)}\n`,
    );
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        { parse: (value: string) => value, brief: "the endpoint id", placeholder: "endpointId" },
      ],
    },
    flags: { ...globalFlags },
  },
  docs: { brief: "show a single endpoint by id" },
});

// Shared dedup-config flags for `endpoints create` / `endpoints update` (ADR-0104). `--dedup-mode`
// selects the mode; `--dedup-window` the bucket seconds; `--dedup-field` / `--dedup-exclude` are
// comma-separated field paths for `fields` mode. Absent `--dedup-mode` = no config (create: the
// default, which is `off` / log every request; update: nothing to set — use --dedup-reset).
// buildDedupConfig validates against the shared schema
// (the same one the api enforces) so a bad combo fails at the CLI, before the request.
const dedupFlags = {
  dedupMode: {
    kind: "enum" as const,
    values: DEDUP_MODES,
    brief: `dedup mode (${DEDUP_MODES.join("|")})`,
    optional: true as const,
  },
  dedupWindow: {
    kind: "parsed" as const,
    parse: (value: string) => {
      // Strict decimal integer only: Number() would accept 1e3 / 0x10 / " 5 " and Number.isInteger
      // would pass them, coercing a fat-fingered value into a valid-but-wrong window.
      if (!/^\d+$/.test(value)) {
        throw new Error("--dedup-window must be a whole number of seconds (e.g. 300)");
      }
      return Number(value);
    },
    brief: `dedup window in seconds (default ${DEFAULT_DEDUP_WINDOW_SECONDS})`,
    optional: true as const,
  },
  dedupField: {
    kind: "parsed" as const,
    parse: (value: string) => value,
    brief: "fields-mode include paths, comma-separated (e.g. body.id,headers.x-event-id)",
    optional: true as const,
  },
  dedupExclude: {
    kind: "parsed" as const,
    parse: (value: string) => value,
    brief: "fields-mode exclude paths, comma-separated",
    optional: true as const,
  },
};
interface DedupFlagValues {
  dedupMode?: DedupMode;
  dedupWindow?: number;
  dedupField?: string;
  dedupExclude?: string;
}
function splitPaths(s?: string): string[] {
  return s
    ? s
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean)
    : [];
}
/** True if the caller set any dedup-config flag (mode or a sub-flag). */
function hasAnyDedupFlag(flags: DedupFlagValues): boolean {
  return (
    flags.dedupMode !== undefined ||
    flags.dedupWindow !== undefined ||
    flags.dedupField !== undefined ||
    flags.dedupExclude !== undefined
  );
}

/**
 * Build (and validate) a DedupConfig from the flags, or undefined when NO dedup flag was given.
 * Rejects (rather than silently drops) contradictory combinations: a sub-flag without --dedup-mode,
 * or --dedup-field/--dedup-exclude with a non-`fields` mode — silent drops would over/under-collapse.
 */
function buildDedupConfig(flags: DedupFlagValues): DedupConfig | undefined {
  const hasSubFlag =
    flags.dedupWindow !== undefined ||
    flags.dedupField !== undefined ||
    flags.dedupExclude !== undefined;
  if (flags.dedupMode === undefined) {
    if (hasSubFlag) {
      throw new MissingInputError(
        "--dedup-window / --dedup-field / --dedup-exclude require --dedup-mode <mode>",
      );
    }
    return undefined;
  }
  if (
    flags.dedupMode !== "fields" &&
    (flags.dedupField !== undefined || flags.dedupExclude !== undefined)
  ) {
    throw new MissingInputError(
      "--dedup-field / --dedup-exclude are only valid with --dedup-mode fields",
    );
  }
  // `off` collapses nothing, so it carries no window. Reject an explicit --dedup-window with off
  // rather than silently dropping it (the same reject-don't-drop rule as the field flags above).
  if (flags.dedupMode === "off") {
    if (flags.dedupWindow !== undefined) {
      throw new MissingInputError("--dedup-window is not valid with --dedup-mode off");
    }
    return { mode: "off" };
  }
  const windowSeconds = flags.dedupWindow ?? DEFAULT_DEDUP_WINDOW_SECONDS;
  const candidate =
    flags.dedupMode === "fields"
      ? {
          mode: flags.dedupMode,
          windowSeconds,
          fields: {
            include: splitPaths(flags.dedupField),
            ...(flags.dedupExclude ? { exclude: splitPaths(flags.dedupExclude) } : {}),
          },
        }
      : { mode: flags.dedupMode, windowSeconds };
  const parsed = DedupConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new MissingInputError(
      `invalid dedup config: ${parsed.error.issues[0]?.message ?? "validation failed"}`,
    );
  }
  return parsed.data;
}

interface CreateFlags extends GlobalFlags, DedupFlagValues {}

export const endpointsCreateCommand = buildCommand<CreateFlags, [string], AppContext>({
  async func(this: AppContext, flags, name) {
    const client = await authedClient(this, flags);
    if (client instanceof NotLoggedInError) return client;
    const { format, color } = resolveGlobals(this, flags);
    const created = await client.endpointsCreate({ name, dedupConfig: buildDedupConfig(flags) });
    if (format === "json") {
      // Machine view: the whole record (incl. the ingestUrl) to stdout, nothing to stderr.
      this.process.stdout.write(`${renderJson(created)}\n`);
      return;
    }
    // Human view: the record (with the ingest url) to stdout; the where-to-find-it-again hint to stderr so
    // a pipe capturing stdout still gets a clean record. The ingest token is sealed at rest (ADR-0101), so
    // the url is NOT a one-time reveal — it can be re-read any time and there is nothing to lose.
    this.process.stdout.write(`${renderCreatedEndpoint(created, color)}\n`);
    this.process.stderr.write(
      `the ingest url is shown again any time — \`wbhk endpoints reveal ${created.id}\`, or the dashboard.\n`,
    );
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        { parse: (value: string) => value, brief: "a name for the endpoint", placeholder: "name" },
      ],
    },
    flags: { ...globalFlags, ...dedupFlags },
  },
  docs: { brief: "create an endpoint and print its ingest url" },
});

interface UpdateFlags extends GlobalFlags, DedupFlagValues {
  dedupReset: boolean;
}

export const endpointsUpdateCommand = buildCommand<UpdateFlags, [string], AppContext>({
  async func(this: AppContext, flags, endpointId) {
    const client = await authedClient(this, flags);
    if (client instanceof NotLoggedInError) return client;
    const { format, color } = resolveGlobals(this, flags);
    let dedupConfig: DedupConfig | null;
    if (flags.dedupReset) {
      // --dedup-reset and a config are contradictory — reject rather than silently letting reset win.
      if (hasAnyDedupFlag(flags)) {
        throw new MissingInputError(
          "--dedup-reset cannot be combined with --dedup-mode / --dedup-window / --dedup-field / --dedup-exclude",
        );
      }
      dedupConfig = null; // reset to the default (off / log every request)
    } else {
      const built = buildDedupConfig(flags);
      if (built === undefined) {
        throw new MissingInputError(
          "specify --dedup-mode <mode> (with optional --dedup-window / --dedup-field / --dedup-exclude), or --dedup-reset to clear the config",
        );
      }
      dedupConfig = built;
    }
    const updated = await client.endpointsUpdate({ endpointId, dedupConfig });
    if (format === "json") {
      this.process.stdout.write(`${renderJson(updated)}\n`);
      return;
    }
    this.process.stdout.write(`${renderEndpoint(updated, color)}\n`);
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        { parse: (value: string) => value, brief: "the endpoint id", placeholder: "endpointId" },
      ],
    },
    flags: {
      ...globalFlags,
      ...dedupFlags,
      dedupReset: {
        kind: "boolean",
        brief: "reset the dedup config to the default (off — log every request)",
        default: false,
      },
    },
  },
  docs: { brief: "update an endpoint's deduplication config" },
});

// `wbhk endpoints delete <id>` (soft delete) + `wbhk endpoints rotate <id>` (replace the ingest url) —
// the destructive write commands (ADR-0076). Both gate on confirmation: `--yes` skips it; in an
// interactive TTY without `--yes` the user must type `yes`; in a non-TTY without `--yes` they refuse
// (ConfirmationError, exit 2) so a script can't destroy an endpoint by accident. Delete prints the
// {id, deleted} record; rotate prints the NEW ingest url exactly like create.

export interface DestructiveFlags extends GlobalFlags {
  yes: boolean;
}

/** The `--yes` boolean shared by the destructive commands. */
export const yesFlag = {
  yes: {
    kind: "boolean" as const,
    brief: "skip the confirmation prompt (required to delete/rotate non-interactively)",
    default: false,
  },
};

/**
 * Gate a destructive action: returns a ConfirmationError to surface (the command `return`s it) unless the
 * action is confirmed — by `--yes`, or by typing `yes` at an interactive prompt. The prompt uses
 * promptLine (an ECHOING read on stderr, so the user sees what they type and stdout stays clean for
 * `--output json`); a non-TTY without `--yes` refuses rather than acting.
 */
export async function confirmDestructive(
  ctx: AppContext,
  yes: boolean,
  prompt: string,
): Promise<ConfirmationError | undefined> {
  if (yes) return undefined;
  if (!ctx.io.isInteractive) {
    return new ConfirmationError(
      "not confirmed — re-run with --yes (stdin is not an interactive terminal).",
    );
  }
  const answer = await ctx.io.promptLine(`${prompt}\ntype 'yes' to confirm: `);
  if (answer.trim().toLowerCase() === "yes") return undefined;
  return new ConfirmationError("aborted — not confirmed.");
}

export const endpointsDeleteCommand = buildCommand<DestructiveFlags, [string], AppContext>({
  async func(this: AppContext, flags, endpointId) {
    const client = await authedClient(this, flags);
    if (client instanceof NotLoggedInError) return client;
    const { format, color: _color } = resolveGlobals(this, flags);
    const blocked = await confirmDestructive(
      this,
      flags.yes,
      `permanently delete endpoint ${endpointId}? its ingest url stops accepting new events and it's removed from listings (captured events are kept).`,
    );
    if (blocked) return blocked;
    const deleted = await client.endpointsDelete(endpointId);
    if (format === "json") {
      this.process.stdout.write(`${renderJson(deleted)}\n`);
      return;
    }
    this.process.stdout.write(`${renderDeletedEndpoint(deleted)}\n`);
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        { parse: (value: string) => value, brief: "the endpoint id", placeholder: "endpointId" },
      ],
    },
    flags: { ...globalFlags, ...yesFlag },
  },
  docs: { brief: "delete an endpoint (its ingest url stops working; events are kept)" },
});

export const endpointsRotateCommand = buildCommand<DestructiveFlags, [string], AppContext>({
  async func(this: AppContext, flags, endpointId) {
    const client = await authedClient(this, flags);
    if (client instanceof NotLoggedInError) return client;
    const { format, color } = resolveGlobals(this, flags);
    const blocked = await confirmDestructive(
      this,
      flags.yes,
      `rotate endpoint ${endpointId}? the current ingest url is revoked and a new one is issued.`,
    );
    if (blocked) return blocked;
    const rotated = await client.endpointsRotate(endpointId);
    if (format === "json") {
      // Machine view: the whole record (incl. the new ingestUrl) to stdout, nothing to stderr.
      this.process.stdout.write(`${renderJson(rotated)}\n`);
      return;
    }
    // Human view: the record (with the new ingest url) to stdout; the caveat to stderr so a pipe capturing
    // stdout still gets a clean record. The caveat is the REVOCATION — the old url stops working within
    // moments (immediately once the ingest cache evicts; the DB no longer honors it). The NEW url is not a
    // one-time reveal: it's sealed at rest (ADR-0101) and re-readable any time.
    this.process.stdout.write(`${renderCreatedEndpoint(rotated, color)}\n`);
    this.process.stderr.write(
      `the previous url is revoked and stops working. the new one is shown again any time — \`wbhk endpoints reveal ${endpointId}\`.\n`,
    );
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        { parse: (value: string) => value, brief: "the endpoint id", placeholder: "endpointId" },
      ],
    },
    flags: { ...globalFlags, ...yesFlag },
  },
  docs: { brief: "rotate an endpoint's ingest url (revokes the old one, issues a new one)" },
});

// `wbhk endpoints reveal <id>` — re-display an endpoint's always-shown ingest url (S8-remainder / ADR-0101).
// Non-destructive (does NOT rotate). A bearer-credential disclosure, so it's audited server-side. Prints
// null for endpoints created before sealed storage (their token is gone — rotate to mint a fresh one).
export const endpointsRevealCommand = buildCommand<GlobalFlags, [string], AppContext>({
  async func(this: AppContext, flags, endpointId) {
    const client = await authedClient(this, flags);
    if (client instanceof NotLoggedInError) return client;
    const { format } = resolveGlobals(this, flags);
    const revealed = await client.endpointsRevealIngestUrl(endpointId);
    if (format === "json") {
      this.process.stdout.write(`${renderJson(revealed)}\n`);
      return;
    }
    if (revealed.ingestUrl === null) {
      this.process.stderr.write(
        "no ingest url on record for this endpoint (created before it was retrievable) — rotate to mint a fresh one.\n",
      );
      return;
    }
    // The url IS the credential — print it clean to stdout so a pipe captures just the url.
    this.process.stdout.write(`${revealed.ingestUrl}\n`);
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        { parse: (value: string) => value, brief: "the endpoint id", placeholder: "endpointId" },
      ],
    },
    flags: { ...globalFlags },
  },
  docs: { brief: "reveal an endpoint's current ingest url (does not rotate)" },
});

// `wbhk endpoints add-provider-secret <id> --provider <p>` / `list-provider-secrets <id>` /
// `revoke-provider-secret <id> <secretId>` — manage an endpoint's inbound-verification signing secrets
// (ADR-0078). The secret is read via a no-echo prompt or piped stdin (NEVER an argv flag — that would
// leak into shell history + the process list); the server seals it and never returns the plaintext.

interface AddProviderSecretFlags extends GlobalFlags {
  provider: Provider;
  label?: string;
  kind: "signing_secret" | "verify_token";
}

export const endpointsAddProviderSecretCommand = buildCommand<
  AddProviderSecretFlags,
  [string],
  AppContext
>({
  async func(this: AppContext, flags, endpointId) {
    const client = await authedClient(this, flags);
    if (client instanceof NotLoggedInError) return client;
    const { format, color } = resolveGlobals(this, flags);
    // NEVER take the secret as an argv flag. Interactive: a hidden (no-echo) prompt on stderr.
    // Non-interactive (scripts/CI): read it from piped stdin.
    const what = flags.kind === "verify_token" ? "verify token" : "signing secret";
    const secret = (
      this.io.isInteractive
        ? await this.io.promptSecret(`${flags.provider} ${what}: `)
        : await this.io.readStdin()
    ).trim();
    if (secret.length === 0) {
      return new MissingInputError(
        `no ${what} provided — type it at the prompt, or pipe it on stdin.`,
      );
    }
    const added = await client.addProviderSecret({
      endpointId,
      provider: flags.provider,
      secret,
      label: flags.label,
      kind: flags.kind,
    });
    this.process.stdout.write(
      format === "json" ? `${renderJson(added)}\n` : `${renderAddedProviderSecret(added, color)}\n`,
    );
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        { parse: (value: string) => value, brief: "the endpoint id", placeholder: "endpointId" },
      ],
    },
    flags: {
      ...globalFlags,
      provider: {
        kind: "enum",
        values: PROVIDERS,
        brief: `the provider scheme (${PROVIDERS.join("|")})`,
        placeholder: "provider",
      },
      label: {
        kind: "parsed",
        parse: (value: string) => value,
        brief: "an optional display label",
        optional: true,
      },
      kind: {
        kind: "enum",
        values: ["signing_secret", "verify_token"],
        brief:
          "signing_secret (default) or verify_token (a Meta hub.verify_token GET-handshake token)",
        default: "signing_secret",
      },
    },
  },
  docs: {
    brief:
      "register a provider signing secret or verify token on an endpoint (read via prompt or stdin)",
  },
});

export const endpointsListProviderSecretsCommand = buildCommand<GlobalFlags, [string], AppContext>({
  async func(this: AppContext, flags, endpointId) {
    const client = await authedClient(this, flags);
    if (client instanceof NotLoggedInError) return client;
    const { format, color } = resolveGlobals(this, flags);
    // Not paginated — a human-managed handful per endpoint; the server returns the whole set at once.
    const items = await client.listProviderSecrets(endpointId);
    if (format === "json") {
      this.process.stdout.write(`${renderJson({ items })}\n`);
      return;
    }
    this.process.stdout.write(
      items.length === 0
        ? "no provider secrets.\n"
        : `${renderProviderSecretsTable(items, color)}\n`,
    );
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        { parse: (value: string) => value, brief: "the endpoint id", placeholder: "endpointId" },
      ],
    },
    flags: { ...globalFlags },
  },
  docs: { brief: "list an endpoint's provider signing secrets (metadata only)" },
});

export const endpointsRevokeProviderSecretCommand = buildCommand<
  DestructiveFlags,
  [string, string],
  AppContext
>({
  async func(this: AppContext, flags, endpointId, secretId) {
    const client = await authedClient(this, flags);
    if (client instanceof NotLoggedInError) return client;
    const { format } = resolveGlobals(this, flags);
    const blocked = await confirmDestructive(
      this,
      flags.yes,
      `revoke provider secret ${secretId} on endpoint ${endpointId}? inbound webhooks signed with it stop verifying immediately.`,
    );
    if (blocked) return blocked;
    const revoked = await client.revokeProviderSecret({ endpointId, secretId });
    this.process.stdout.write(
      format === "json" ? `${renderJson(revoked)}\n` : `${renderRevokedProviderSecret(revoked)}\n`,
    );
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        { parse: (value: string) => value, brief: "the endpoint id", placeholder: "endpointId" },
        {
          parse: (value: string) => value,
          brief: "the provider secret id",
          placeholder: "secretId",
        },
      ],
    },
    flags: { ...globalFlags, ...yesFlag },
  },
  docs: { brief: "revoke a provider signing secret (verification stops honoring it immediately)" },
});
