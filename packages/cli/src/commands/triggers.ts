import { buildCommand } from "@stricli/core";

import type { AppContext } from "../context.js";
import { NotLoggedInError } from "../errors.js";
import { globalFlags, resolveGlobals, type GlobalFlags } from "../global-flags.js";
import { renderJson } from "../output/format.js";
import {
  renderRevokedTrigger,
  renderTrigger,
  renderTriggersTable,
  renderTriggerWait,
} from "../output/render.js";
import { authedClient, parseLimit } from "./shared.js";

// `wbhk triggers add|list|revoke|wait` — webhook→agent trigger subscriptions (S5). A trigger registers
// this principal to be woken when an endpoint captures a new event; `wait` consumes those events (a
// short-poll: returns immediately with what's past the cursor, call again to continue). It creates no
// outbound delivery; it only lets you consume events you can already read.

interface AddFlags extends GlobalFlags {
  name?: string;
}

export const triggersAddCommand = buildCommand<AddFlags, [string], AppContext>({
  async func(this: AppContext, flags, endpointId) {
    const client = await authedClient(this, flags);
    if (client instanceof NotLoggedInError) return client;
    const { format } = resolveGlobals(this, flags);
    const created = await client.triggersCreate({ endpointId, name: flags.name });
    this.process.stdout.write(
      format === "json" ? `${renderJson(created)}\n` : `${renderTrigger(created)}\n`,
    );
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          parse: (v: string) => v,
          brief: "the endpoint id to subscribe to",
          placeholder: "endpointId",
        },
      ],
    },
    flags: {
      ...globalFlags,
      name: {
        kind: "parsed",
        parse: (v: string) => v,
        brief: "an optional label for the trigger",
        optional: true,
      },
    },
  },
  docs: { brief: "subscribe to an endpoint to receive webhook→agent triggers" },
});

interface ListFlags extends GlobalFlags {
  endpoint?: string;
}

export const triggersListCommand = buildCommand<ListFlags, [], AppContext>({
  async func(this: AppContext, flags) {
    const client = await authedClient(this, flags);
    if (client instanceof NotLoggedInError) return client;
    const { format } = resolveGlobals(this, flags);
    const items = await client.triggersList(flags.endpoint);
    if (format === "json") {
      this.process.stdout.write(`${renderJson({ items })}\n`);
      return;
    }
    this.process.stdout.write(
      items.length === 0 ? "no triggers.\n" : `${renderTriggersTable(items)}\n`,
    );
  },
  parameters: {
    flags: {
      ...globalFlags,
      endpoint: {
        kind: "parsed",
        parse: (v: string) => v,
        brief: "filter to one endpoint id",
        optional: true,
      },
    },
  },
  docs: { brief: "list the org's active agent triggers" },
});

interface WaitFlags extends GlobalFlags {
  cursor?: string;
  limit?: number;
}

export const triggersWaitCommand = buildCommand<WaitFlags, [string], AppContext>({
  async func(this: AppContext, flags, triggerId) {
    const client = await authedClient(this, flags);
    if (client instanceof NotLoggedInError) return client;
    const { format, color } = resolveGlobals(this, flags);
    const result = await client.triggersWait(triggerId, {
      cursor: flags.cursor,
      limit: flags.limit,
    });
    this.process.stdout.write(
      format === "json" ? `${renderJson(result)}\n` : `${renderTriggerWait(result, color)}\n`,
    );
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [{ parse: (v: string) => v, brief: "the trigger id", placeholder: "triggerId" }],
    },
    flags: {
      ...globalFlags,
      cursor: {
        kind: "parsed",
        parse: (v: string) => v,
        brief: "resume from a prior call's nextCursor",
        optional: true,
      },
      limit: {
        kind: "parsed",
        parse: parseLimit,
        brief: "max events to return (1–200)",
        optional: true,
      },
    },
  },
  docs: { brief: "consume the next events for a trigger subscription (short-poll)" },
});

export const triggersRevokeCommand = buildCommand<GlobalFlags, [string], AppContext>({
  async func(this: AppContext, flags, triggerId) {
    const client = await authedClient(this, flags);
    if (client instanceof NotLoggedInError) return client;
    const { format } = resolveGlobals(this, flags);
    const revoked = await client.triggersRevoke(triggerId);
    this.process.stdout.write(
      format === "json" ? `${renderJson(revoked)}\n` : `${renderRevokedTrigger(revoked)}\n`,
    );
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [{ parse: (v: string) => v, brief: "the trigger id", placeholder: "triggerId" }],
    },
    flags: { ...globalFlags },
  },
  docs: { brief: "revoke an agent trigger" },
});
