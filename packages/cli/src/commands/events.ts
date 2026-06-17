import { buildCommand } from "@stricli/core";
import { bytesToB64, PROVIDERS } from "@webhook-co/shared";

import type { AppContext } from "../context.js";
import { NotLoggedInError } from "../errors.js";
import { renderJson, resolveFormat, type OutputFormat } from "../output/format.js";
import { renderEvent, renderEventsTable } from "../output/render.js";
import { authedClient, collectPages, emitList, parseLimit } from "./shared.js";

// `wbhk events list <endpointId>` / `wbhk events get <id>` — read views over captured events. List
// paginates and filters by `--provider`; get prints a single event in full fidelity. Same auth +
// shared-schema parsing as endpoints; `--output json` is the machine view.

interface ListFlags {
  output: OutputFormat;
  apiUrl?: string;
  limit?: number;
  cursor?: string;
  all: boolean;
  provider?: (typeof PROVIDERS)[number];
}

interface GetFlags {
  output: OutputFormat;
  apiUrl?: string;
}

export const eventsListCommand = buildCommand<ListFlags, [string], AppContext>({
  async func(this: AppContext, flags, endpointId) {
    const client = await authedClient(this, flags);
    if (client instanceof NotLoggedInError) return client;
    const result = await collectPages(
      (cursor) =>
        client.eventsList(endpointId, { cursor, limit: flags.limit, provider: flags.provider }),
      { cursor: flags.cursor, all: flags.all },
    );
    emitList(this, result, {
      format: resolveFormat(flags.output),
      renderTable: renderEventsTable,
      empty: "no events.",
    });
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        { parse: (value: string) => value, brief: "the endpoint id", placeholder: "endpointId" },
      ],
    },
    flags: {
      output: { kind: "enum", values: ["text", "json"], brief: "output format", default: "text" },
      apiUrl: {
        kind: "parsed",
        parse: (value: string) => value,
        brief: "override the API base URL",
        optional: true,
      },
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
        brief: "filter by provider",
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
    const event = await client.eventsGet(eventId);
    this.process.stdout.write(
      resolveFormat(flags.output) === "json"
        ? `${renderJson(event)}\n`
        : `${renderEvent(event, this.colorEnabled)}\n`,
    );
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        { parse: (value: string) => value, brief: "the event id", placeholder: "eventId" },
      ],
    },
    flags: {
      output: { kind: "enum", values: ["text", "json"], brief: "output format", default: "text" },
      apiUrl: {
        kind: "parsed",
        parse: (value: string) => value,
        brief: "override the API base URL",
        optional: true,
      },
    },
  },
  docs: { brief: "show a single event by id" },
});

// `wbhk events payload <eventId>` — print the captured event's raw body (what `events get` omits).
// Text mode writes the exact bytes verbatim (no added newline) so `> file` is byte-exact and a JSON
// body prints readably; `--output json` emits the lossless `{contentType, bytes, bodyBase64}` envelope,
// the only safe view for a binary payload. The body rides a base64 envelope on the wire (ADR-0015).
export const eventsPayloadCommand = buildCommand<GetFlags, [string], AppContext>({
  async func(this: AppContext, flags, eventId) {
    const client = await authedClient(this, flags);
    if (client instanceof NotLoggedInError) return client;
    const { contentType, body } = await client.eventsGetPayload(eventId);
    if (resolveFormat(flags.output) === "json") {
      this.process.stdout.write(
        `${renderJson({ contentType, bytes: body.byteLength, bodyBase64: bytesToB64(body) })}\n`,
      );
      return;
    }
    // Exact bytes, verbatim (text decode). Binary payloads print as mojibake here — use --output json.
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
      output: {
        kind: "enum",
        values: ["text", "json"],
        brief: "output format (json = lossless base64 envelope)",
        default: "text",
      },
      apiUrl: {
        kind: "parsed",
        parse: (value: string) => value,
        brief: "override the API base URL",
        optional: true,
      },
    },
  },
  docs: { brief: "print a captured event's raw body" },
});
