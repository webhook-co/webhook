import { buildCommand } from "@stricli/core";

import type { AppContext } from "../context.js";
import { NotLoggedInError } from "../errors.js";
import { globalFlags, resolveGlobals, type GlobalFlags } from "../global-flags.js";
import { renderJson } from "../output/format.js";
import {
  renderRemovedSubscription,
  renderSubscription,
  renderSubscriptionsTable,
} from "../output/render.js";
import { authedClient } from "./shared.js";

// `wbhk subscriptions add|list|remove` — the Tier-3 routing rules that auto-deliver a source endpoint's
// captured events to a destination (S3 Slice 3). `add` upserts the routing for an (endpoint, destination)
// pair, selecting on provider + event-type patterns + require-verified; the zero-config default routes
// everything from the endpoint to the destination.

interface AddFlags extends GlobalFlags {
  provider?: string;
  eventType?: string[];
  requireVerified: boolean;
}

export const subscriptionsAddCommand = buildCommand<AddFlags, [string, string], AppContext>({
  async func(this: AppContext, flags, sourceEndpointId, destinationId) {
    const client = await authedClient(this, flags);
    if (client instanceof NotLoggedInError) return client;
    const { format } = resolveGlobals(this, flags);
    const created = await client.subscriptionsCreate({
      sourceEndpointId,
      destinationId,
      provider: flags.provider ?? null,
      eventTypes: flags.eventType, // undefined → server defaults to ['*'] (match-all)
      requireVerified: flags.requireVerified,
    });
    this.process.stdout.write(
      format === "json" ? `${renderJson(created)}\n` : `${renderSubscription(created)}\n`,
    );
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          parse: (v: string) => v,
          brief: "the source endpoint id",
          placeholder: "sourceEndpointId",
        },
        { parse: (v: string) => v, brief: "the destination id", placeholder: "destinationId" },
      ],
    },
    flags: {
      ...globalFlags,
      provider: {
        kind: "parsed",
        parse: (v: string) => v,
        brief: "only route this provider's events (default: any provider)",
        optional: true,
      },
      eventType: {
        kind: "parsed",
        parse: (v: string) => v,
        brief:
          "event-type patterns to route (exact / 'charge.*' / '*'; repeatable or comma-separated; default '*')",
        variadic: ",",
        optional: true,
      },
      requireVerified: {
        kind: "boolean",
        brief: "only route verified (signature-checked) events",
        default: false,
      },
    },
  },
  docs: { brief: "auto-deliver a source endpoint's events to a destination" },
});

interface ListFlags extends GlobalFlags {
  endpoint?: string;
}

export const subscriptionsListCommand = buildCommand<ListFlags, [], AppContext>({
  async func(this: AppContext, flags) {
    const client = await authedClient(this, flags);
    if (client instanceof NotLoggedInError) return client;
    const { format } = resolveGlobals(this, flags);
    const items = await client.subscriptionsList(flags.endpoint);
    if (format === "json") {
      this.process.stdout.write(`${renderJson({ items })}\n`);
      return;
    }
    this.process.stdout.write(
      items.length === 0 ? "no subscriptions.\n" : `${renderSubscriptionsTable(items)}\n`,
    );
  },
  parameters: {
    flags: {
      ...globalFlags,
      endpoint: {
        kind: "parsed",
        parse: (v: string) => v,
        brief: "filter to one source endpoint id",
        optional: true,
      },
    },
  },
  docs: { brief: "list the org's delivery subscriptions" },
});

export const subscriptionsRemoveCommand = buildCommand<GlobalFlags, [string], AppContext>({
  async func(this: AppContext, flags, subscriptionId) {
    const client = await authedClient(this, flags);
    if (client instanceof NotLoggedInError) return client;
    const { format } = resolveGlobals(this, flags);
    const removed = await client.subscriptionsDelete(subscriptionId);
    this.process.stdout.write(
      format === "json" ? `${renderJson(removed)}\n` : `${renderRemovedSubscription(removed)}\n`,
    );
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        { parse: (v: string) => v, brief: "the subscription id", placeholder: "subscriptionId" },
      ],
    },
    flags: { ...globalFlags },
  },
  docs: { brief: "remove a delivery subscription" },
});
