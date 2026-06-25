import { buildCommand } from "@stricli/core";

import type { AppContext } from "../context.js";
import { ConfirmationError, NotLoggedInError } from "../errors.js";
import { globalFlags, resolveGlobals, type GlobalFlags } from "../global-flags.js";
import { renderJson } from "../output/format.js";
import {
  renderCreatedEndpoint,
  renderDeletedEndpoint,
  renderEndpoint,
  renderEndpointsTable,
} from "../output/render.js";
import { authedClient, collectPages, emitList, parseLimit } from "./shared.js";

// `wbhk endpoints list` / `wbhk endpoints get <id>` — read views over the org's endpoints. Both reuse
// the Slice-9 api-client (Bearer + the shared output schema). List paginates (one page, `--all`, or a
// `--cursor`); get prints a single record as a key:value block. `--output json` is the machine view.

interface ListFlags extends GlobalFlags {
  limit?: number;
  cursor?: string;
  all: boolean;
}

type GetFlags = GlobalFlags;

export const endpointsListCommand = buildCommand<ListFlags, [], AppContext>({
  async func(this: AppContext, flags) {
    const client = await authedClient(this, flags);
    if (client instanceof NotLoggedInError) return client;
    const { format, color } = resolveGlobals(this, flags);
    const result = await collectPages(
      (cursor) => client.endpointsList({ cursor, limit: flags.limit }),
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

export const endpointsCreateCommand = buildCommand<GetFlags, [string], AppContext>({
  async func(this: AppContext, flags, name) {
    const client = await authedClient(this, flags);
    if (client instanceof NotLoggedInError) return client;
    const { format, color } = resolveGlobals(this, flags);
    const created = await client.endpointsCreate({ name });
    if (format === "json") {
      // Machine view: the whole record (incl. the one-time ingestUrl) to stdout, nothing to stderr.
      this.process.stdout.write(`${renderJson(created)}\n`);
      return;
    }
    // Human view: the record (with the ingest url) to stdout; the save-it caveat to stderr so a pipe
    // capturing stdout still gets a clean record. The ingest url embeds a secret shown only once.
    this.process.stdout.write(`${renderCreatedEndpoint(created, color)}\n`);
    this.process.stderr.write(
      "save the ingest url now — it's shown once and can't be recovered (rotate by creating a new endpoint).\n",
    );
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        { parse: (value: string) => value, brief: "a name for the endpoint", placeholder: "name" },
      ],
    },
    flags: { ...globalFlags },
  },
  docs: { brief: "create an endpoint and reveal its ingest url (shown once)" },
});

// `wbhk endpoints delete <id>` (soft delete) + `wbhk endpoints rotate <id>` (replace the ingest url) —
// the destructive write commands (ADR-0076). Both gate on confirmation: `--yes` skips it; in an
// interactive TTY without `--yes` the user must type `yes`; in a non-TTY without `--yes` they refuse
// (ConfirmationError, exit 2) so a script can't destroy an endpoint by accident. Delete prints the
// {id, deleted} record; rotate reveals the NEW one-time ingest url exactly like create.

interface DestructiveFlags extends GlobalFlags {
  yes: boolean;
}

/** The `--yes` boolean shared by the destructive commands. */
const yesFlag = {
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
async function confirmDestructive(
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
      // Machine view: the whole record (incl. the new one-time ingestUrl) to stdout, nothing to stderr.
      this.process.stdout.write(`${renderJson(rotated)}\n`);
      return;
    }
    // Human view: the record (with the new ingest url) to stdout; the caveat to stderr so a pipe
    // capturing stdout still gets a clean record. The old url is revoked (hard cutover) — it stops
    // working within moments (immediately once the ingest cache evicts; the DB no longer honors it).
    this.process.stdout.write(`${renderCreatedEndpoint(rotated, color)}\n`);
    this.process.stderr.write(
      "save the new ingest url now — it's shown once. the previous url is revoked and stops working.\n",
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
  docs: { brief: "rotate an endpoint's ingest url (kills the old one, reveals a new one once)" },
});
