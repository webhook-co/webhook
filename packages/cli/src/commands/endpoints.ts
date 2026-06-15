import { buildCommand } from "@stricli/core";

import type { AppContext } from "../context.js";
import { NotLoggedInError } from "../errors.js";
import { renderJson, resolveFormat, type OutputFormat } from "../output/format.js";
import { renderEndpoint, renderEndpointsTable } from "../output/render.js";
import { authedClient, collectPages, emitList, parseLimit } from "./shared.js";

// `wbhk endpoints list` / `wbhk endpoints get <id>` — read views over the org's endpoints. Both reuse
// the Slice-9 api-client (Bearer + the shared output schema). List paginates (one page, `--all`, or a
// `--cursor`); get prints a single record as a key:value block. `--output json` is the machine view.

interface ListFlags {
  output: OutputFormat;
  apiUrl?: string;
  limit?: number;
  cursor?: string;
  all: boolean;
}

interface GetFlags {
  output: OutputFormat;
  apiUrl?: string;
}

export const endpointsListCommand = buildCommand<ListFlags, [], AppContext>({
  async func(this: AppContext, flags) {
    const client = await authedClient(this, flags);
    if (client instanceof NotLoggedInError) return client;
    const result = await collectPages(
      (cursor) => client.endpointsList({ cursor, limit: flags.limit }),
      { cursor: flags.cursor, all: flags.all },
    );
    emitList(this, result, {
      format: resolveFormat(flags.output),
      renderTable: renderEndpointsTable,
      empty: "no endpoints.",
    });
  },
  parameters: {
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
    },
  },
  docs: { brief: "list your endpoints" },
});

export const endpointsGetCommand = buildCommand<GetFlags, [string], AppContext>({
  async func(this: AppContext, flags, endpointId) {
    const client = await authedClient(this, flags);
    if (client instanceof NotLoggedInError) return client;
    const endpoint = await client.endpointsGet(endpointId);
    this.process.stdout.write(
      resolveFormat(flags.output) === "json"
        ? `${renderJson(endpoint)}\n`
        : `${renderEndpoint(endpoint, this.colorEnabled)}\n`,
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
      output: { kind: "enum", values: ["text", "json"], brief: "output format", default: "text" },
      apiUrl: {
        kind: "parsed",
        parse: (value: string) => value,
        brief: "override the API base URL",
        optional: true,
      },
    },
  },
  docs: { brief: "show a single endpoint by id" },
});
