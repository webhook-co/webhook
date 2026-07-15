import { buildCommand } from "@stricli/core";
import { bytesToB64, PROVIDERS, VERIFICATION_STATES } from "@webhook-co/shared";

import { ENV_DASHBOARD_URL_VAR, resolveDashboardUrl } from "../api-client.js";
import type { AppContext } from "../context.js";
import {
  buildEventDashboardUrl,
  DASHBOARD_SLUG_UNRESOLVED_HELP,
  makeOpenEventEffect,
} from "../dashboard-url.js";
import { NotLoggedInError, OrgUnresolvedError } from "../errors.js";
import { globalFlags, resolveGlobals, type GlobalFlags } from "../global-flags.js";
import { renderJson } from "../output/format.js";
import { renderEvent, renderEventsTable } from "../output/render.js";
import { confirmDestructive, yesFlag, type DestructiveFlags } from "./endpoints.js";
import {
  authedClient,
  collectPages,
  emitList,
  parseIsoDate,
  parseLimit,
  resolveAuthedContext,
} from "./shared.js";

// `wbhk events list <endpointId>` / `wbhk events get <id>` — read views over captured events. List
// paginates and filters by `--provider` and a `--after`/`--before` received-at range; get prints a
// single event in full fidelity. Same auth + shared-schema parsing as endpoints; `--output json` is
// the machine view.

interface ListFlags extends GlobalFlags {
  limit?: number;
  cursor?: string;
  all: boolean;
  provider?: (typeof PROVIDERS)[number][];
  after?: string;
  before?: string;
  status?: (typeof VERIFICATION_STATES)[number][];
  search?: string;
}

type GetFlags = GlobalFlags;

export const eventsListCommand = buildCommand<ListFlags, [string], AppContext>({
  async func(this: AppContext, flags, endpointId) {
    const client = await authedClient(this, flags);
    if (client instanceof NotLoggedInError) return client;
    const { format, color } = resolveGlobals(this, flags);
    const result = await collectPages(
      (cursor) =>
        client.eventsList(endpointId, {
          cursor,
          limit: flags.limit,
          provider: flags.provider,
          receivedAfter: flags.after,
          receivedBefore: flags.before,
          verificationState: flags.status,
          search: flags.search,
        }),
      { cursor: flags.cursor, all: flags.all },
    );
    emitList(this, result, { format, color, renderTable: renderEventsTable, empty: "no events." });
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
      provider: {
        kind: "enum",
        values: PROVIDERS,
        brief: "filter by provider (repeatable, or comma-separated, for multi-select)",
        variadic: ",",
        optional: true,
      },
      after: {
        kind: "parsed",
        parse: parseIsoDate,
        brief: "only events received at/after this time (ISO-8601 / RFC3339)",
        optional: true,
      },
      before: {
        kind: "parsed",
        parse: parseIsoDate,
        brief: "only events received strictly before this time (ISO-8601 / RFC3339)",
        optional: true,
      },
      status: {
        kind: "enum",
        values: VERIFICATION_STATES,
        brief:
          "filter by verification state (verified | failed | unattempted; repeatable / comma-separated)",
        variadic: ",",
        optional: true,
      },
      search: {
        kind: "parsed",
        parse: (value: string) => value,
        brief:
          "substring search over event/provider/external ids + request header names/values (+ exact event id)",
        optional: true,
      },
    },
  },
  docs: { brief: "list captured events for an endpoint" },
});

export const eventsGetCommand = buildCommand<GetFlags, [string], AppContext>({
  async func(this: AppContext, flags, eventId) {
    const client = await authedClient(this, flags);
    if (client instanceof NotLoggedInError) return client;
    const { format, color } = resolveGlobals(this, flags);
    const event = await client.eventsGet(eventId);
    this.process.stdout.write(
      format === "json" ? `${renderJson(event)}\n` : `${renderEvent(event, color)}\n`,
    );
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        { parse: (value: string) => value, brief: "the event id", placeholder: "eventId" },
      ],
    },
    flags: { ...globalFlags },
  },
  docs: { brief: "show a single event by id" },
});

// `wbhk events open <id>` — open a captured event in the web dashboard. The dashboard routes events under
// `/org/<slug>/endpoints/<endpointId>/events/<eventId>`, so we need the event's endpointId (from `events
// get`) and the bound org's slug. The slug comes from a fast LOCAL source (the `--org` selection or the
// profile's persisted org) so the common path never blocks on the network; only an env-key credential —
// whose org isn't in the local store — falls back to a single whoami. `--print` / `--output json` emit the
// url instead of launching a browser (scripting / headless / SSH). Parity with the in-tail TUI `o` key.
interface OpenFlags extends GlobalFlags {
  print: boolean;
}

export const eventsOpenCommand = buildCommand<OpenFlags, [string], AppContext>({
  async func(this: AppContext, flags, eventId) {
    const authed = await resolveAuthedContext(this, flags);
    if (authed instanceof NotLoggedInError) return authed;
    const { client, org, envCredential } = authed;
    const { format } = resolveGlobals(this, flags);
    // The dashboard slug: the EFFECTIVE org's slug when we have it (a purely LOCAL value — the common
    // login-credential path never blocks on the network). For an env (WBHK_API_KEY) credential the local
    // store's org is NOT the bound org, so its slug can only come from whoami — one bounded call, only on
    // that path. If it still can't be resolved (an older login with no persisted org), guide the user rather
    // than open a broken link.
    let slug = org?.slug;
    if (slug === undefined && envCredential) {
      // An env key's org isn't in the local store — ask whoami. A REAL failure (401/expired key, network)
      // must surface as its own error (correct exit code + message), so DON'T swallow it; only a successful
      // response that simply lacks org enrichment falls through to the guidance below.
      slug = (await client.whoami()).organization?.slug || undefined;
    }
    if (!slug) {
      // Non-env: `wbhk whoami`/re-login re-persists the org locally, so that guidance self-heals. An env key
      // persists nothing locally, so pointing it at "run whoami" is a dead-end — send it to the dashboard.
      return new OrgUnresolvedError(
        envCredential
          ? "couldn't determine your organization for this API key — open the event from the web dashboard instead."
          : DASHBOARD_SLUG_UNRESOLVED_HELP,
      );
    }
    const event = await client.eventsGet(eventId);
    const base = resolveDashboardUrl({ env: this.process.env?.[ENV_DASHBOARD_URL_VAR] });
    const url = buildEventDashboardUrl({
      base,
      slug,
      endpointId: event.endpointId,
      eventId: event.id,
    });
    // `--output json` is the machine contract (parity with list/get/payload): emit `{url}` and DON'T launch
    // a browser — a script asked for data, not an interactive side effect. `--print` is the plain-text
    // equivalent. Otherwise reuse the SHARED open-and-report effect (the same one the in-tail `o` key uses)
    // so both surfaces stay in parity for the best-effort launch + copyable-URL message on a headless box.
    if (format === "json") {
      this.process.stdout.write(`${renderJson({ url })}\n`);
      return;
    }
    if (flags.print) {
      this.process.stdout.write(`${url}\n`);
      return;
    }
    const outcome = await makeOpenEventEffect({
      base,
      resolveSlug: async () => slug,
      openBrowser: (u) => this.io.openBrowser(u),
    })({ id: event.id, endpointId: event.endpointId });
    this.process.stderr.write(`${outcome.message}\n`);
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        { parse: (value: string) => value, brief: "the event id", placeholder: "eventId" },
      ],
    },
    flags: {
      ...globalFlags,
      print: {
        kind: "boolean",
        brief: "print the dashboard url instead of opening a browser",
        default: false,
      },
    },
  },
  docs: { brief: "open a captured event in the web dashboard" },
});

// `wbhk events delete <id>` — the destructive event tombstone (S3). Same confirmation gate as endpoints
// delete/rotate: `--yes` skips; an interactive TTY prompts for `yes`; a non-TTY without `--yes` refuses
// (so a script can't wipe an event by accident). Prints the {id, deletedAt} record.
export const eventsDeleteCommand = buildCommand<DestructiveFlags, [string], AppContext>({
  async func(this: AppContext, flags, eventId) {
    const client = await authedClient(this, flags);
    if (client instanceof NotLoggedInError) return client;
    const { format } = resolveGlobals(this, flags);
    const blocked = await confirmDestructive(
      this,
      flags.yes,
      `permanently delete event ${eventId}? its content is redacted and its payload body is purged; it can no longer be read or replayed (this does NOT reduce your metered usage).`,
    );
    if (blocked) return blocked;
    const deleted = await client.eventsDelete(eventId);
    if (format === "json") {
      this.process.stdout.write(`${renderJson(deleted)}\n`);
      return;
    }
    this.process.stdout.write(
      `deleted event ${deleted.id} (at ${deleted.deletedAt.toISOString()})\n`,
    );
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        { parse: (value: string) => value, brief: "the event id", placeholder: "eventId" },
      ],
    },
    flags: { ...globalFlags, ...yesFlag },
  },
  docs: { brief: "delete a captured event (redacts + purges its body; irreversible)" },
});

// `wbhk events payload <eventId>` — print the captured event's raw body (what `events get` omits).
// DEFAULT mode writes the exact bytes verbatim (no added newline) so `> file` is byte-exact and a JSON/text
// body prints READABLY, exactly like the dashboard — this is the human view. `--output json` is the machine
// view: the lossless `{contentType, bytes, bodyBase64}` envelope that mirrors the API/SDK payload shape
// (the contract) and is the only safe view for a binary payload. The body rides a base64 envelope on the
// wire (ADR-0015).
export const eventsPayloadCommand = buildCommand<GetFlags, [string], AppContext>({
  async func(this: AppContext, flags, eventId) {
    const client = await authedClient(this, flags);
    if (client instanceof NotLoggedInError) return client;
    const { format } = resolveGlobals(this, flags);
    const { contentType, body } = await client.eventsGetPayload(eventId);
    if (format === "json") {
      // The lossless machine envelope, byte-for-byte the same shape the API/SDK/MCP return (parity). For a
      // readable payload, run without `--output json` — the default mode decodes and prints it as-is.
      this.process.stdout.write(
        `${renderJson({ contentType, bytes: body.byteLength, bodyBase64: bytesToB64(body) })}\n`,
      );
      return;
    }
    // Exact bytes, verbatim (text decode) — a JSON/text payload prints readably. Binary prints as mojibake
    // here; use --output json for the lossless base64 envelope.
    this.process.stdout.write(new TextDecoder().decode(body));
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        { parse: (value: string) => value, brief: "the event id", placeholder: "eventId" },
      ],
    },
    flags: {
      ...globalFlags,
      output: {
        ...globalFlags.output,
        brief: "output format (default = readable decoded body; json = lossless base64 envelope)",
      },
    },
  },
  docs: { brief: "print a captured event's raw body" },
});
