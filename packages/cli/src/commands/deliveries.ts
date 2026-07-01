import { buildCommand } from "@stricli/core";
import { DELIVERY_STATUSES } from "@webhook-co/shared";

import type { AppContext } from "../context.js";
import { NotLoggedInError } from "../errors.js";
import { globalFlags, resolveGlobals, type GlobalFlags } from "../global-flags.js";
import { renderJson } from "../output/format.js";
import { renderDeliveriesTable, renderDelivery } from "../output/render.js";
import { authedClient, collectPages, emitList, parseLimit } from "./shared.js";

// `wbhk deliveries list` / `wbhk deliveries get <id>` — read views over outbound deliveries (auto-deliveries
// to subscribed destinations + manual replay attempts). List paginates and filters by `--destination`,
// `--subscription`, and a multi-select `--status`; get prints a single delivery in full. Same auth +
// shared-schema parsing as events; `--output json` is the machine view.

interface ListFlags extends GlobalFlags {
  limit?: number;
  cursor?: string;
  all: boolean;
  destination?: string;
  subscription?: string;
  status?: (typeof DELIVERY_STATUSES)[number][];
}

type GetFlags = GlobalFlags;

export const deliveriesListCommand = buildCommand<ListFlags, [], AppContext>({
  async func(this: AppContext, flags) {
    const client = await authedClient(this, flags);
    if (client instanceof NotLoggedInError) return client;
    const { format, color } = resolveGlobals(this, flags);
    const result = await collectPages(
      (cursor) =>
        client.deliveriesList({
          cursor,
          limit: flags.limit,
          destinationId: flags.destination,
          subscriptionId: flags.subscription,
          status: flags.status,
        }),
      { cursor: flags.cursor, all: flags.all },
    );
    emitList(this, result, {
      format,
      color,
      renderTable: (items) => renderDeliveriesTable(items),
      empty: "no deliveries.",
    });
  },
  parameters: {
    positional: { kind: "tuple", parameters: [] },
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
      destination: {
        kind: "parsed",
        parse: (value: string) => value,
        brief: "filter to one destination id",
        optional: true,
      },
      subscription: {
        kind: "parsed",
        parse: (value: string) => value,
        brief: "filter to one subscription id",
        optional: true,
      },
      status: {
        kind: "enum",
        values: DELIVERY_STATUSES,
        brief:
          "filter by status (queued | pending | delivered | failed | dead | blocked | forwarded; repeatable / comma-separated)",
        variadic: ",",
        optional: true,
      },
    },
  },
  docs: { brief: "list outbound deliveries" },
});

export const deliveriesGetCommand = buildCommand<GetFlags, [string], AppContext>({
  async func(this: AppContext, flags, deliveryId) {
    const client = await authedClient(this, flags);
    if (client instanceof NotLoggedInError) return client;
    const { format } = resolveGlobals(this, flags);
    const delivery = await client.deliveriesGet(deliveryId);
    this.process.stdout.write(
      format === "json" ? `${renderJson(delivery)}\n` : `${renderDelivery(delivery)}\n`,
    );
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        { parse: (value: string) => value, brief: "the delivery id", placeholder: "deliveryId" },
      ],
    },
    flags: { ...globalFlags },
  },
  docs: { brief: "show a single outbound delivery by id" },
});
