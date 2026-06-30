import { buildCommand } from "@stricli/core";

import type { AppContext } from "../context.js";
import { NotLoggedInError } from "../errors.js";
import { globalFlags, resolveGlobals, type GlobalFlags } from "../global-flags.js";
import { renderJson } from "../output/format.js";
import {
  renderReplayDestination,
  renderReplayDestinationsTable,
  renderRemovedReplayDestination,
} from "../output/render.js";
import { authedClient } from "./shared.js";

// `wbhk replay-destinations add|list|remove` — the org's allowlist of remote https URLs that
// `events.replay` may deliver to (ADR-0081). A safety/trust control: the replay target references a
// registered destination by id, never a free-form URL, so a remote replay can't be steered into an
// SSRF/confused-deputy vector. `add` validates the URL structurally (https, no IP-literal host, allowed
// port, public FQDN); the authoritative private-range guard runs at delivery time (engine-side).

interface AddFlags extends GlobalFlags {
  label?: string;
}

export const replayDestinationsAddCommand = buildCommand<AddFlags, [string], AppContext>({
  async func(this: AppContext, flags, url) {
    const client = await authedClient(this, flags);
    if (client instanceof NotLoggedInError) return client;
    const { format } = resolveGlobals(this, flags);
    const created = await client.replayDestinationsCreate({ url, label: flags.label });
    this.process.stdout.write(
      format === "json" ? `${renderJson(created)}\n` : `${renderReplayDestination(created)}\n`,
    );
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        { parse: (value: string) => value, brief: "the https destination url", placeholder: "url" },
      ],
    },
    flags: {
      ...globalFlags,
      label: {
        kind: "parsed",
        parse: (value: string) => value,
        brief: "an optional display label",
        optional: true,
      },
    },
  },
  docs: { brief: "allow a remote https url as a replay destination" },
});

export const replayDestinationsListCommand = buildCommand<GlobalFlags, [], AppContext>({
  async func(this: AppContext, flags) {
    const client = await authedClient(this, flags);
    if (client instanceof NotLoggedInError) return client;
    const { format } = resolveGlobals(this, flags);
    // Not paginated — a human-managed handful per org; the server returns the whole set at once.
    const items = await client.replayDestinationsList();
    if (format === "json") {
      this.process.stdout.write(`${renderJson({ items })}\n`);
      return;
    }
    this.process.stdout.write(
      items.length === 0
        ? "no replay destinations.\n"
        : `${renderReplayDestinationsTable(items)}\n`,
    );
  },
  parameters: { flags: { ...globalFlags } },
  docs: { brief: "list the org's allowed replay destinations" },
});

export const replayDestinationsRemoveCommand = buildCommand<GlobalFlags, [string], AppContext>({
  async func(this: AppContext, flags, destinationId) {
    const client = await authedClient(this, flags);
    if (client instanceof NotLoggedInError) return client;
    const { format } = resolveGlobals(this, flags);
    // Low-stakes + safety-increasing (a removed url can no longer be a replay target, and is easily
    // re-added), so no confirmation gate — unlike endpoints delete, which loses the one-time ingest URL.
    const removed = await client.replayDestinationsDelete(destinationId);
    this.process.stdout.write(
      format === "json"
        ? `${renderJson(removed)}\n`
        : `${renderRemovedReplayDestination(removed)}\n`,
    );
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          parse: (value: string) => value,
          brief: "the replay destination id",
          placeholder: "destinationId",
        },
      ],
    },
    flags: { ...globalFlags },
  },
  docs: { brief: "remove a replay destination from the allowlist" },
});
