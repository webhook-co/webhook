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
    if (format === "json") {
      // The one-time signingSecret (S3 Slice 2) is part of the JSON envelope — present on first create.
      this.process.stdout.write(`${renderJson(created)}\n`);
      return;
    }
    this.process.stdout.write(`${renderReplayDestination(created)}\n`);
    if (created.signingSecret) {
      // Shown ONCE: webhook.co signs every replay to this destination; configure this secret in the
      // receiver's Standard Webhooks verifier. (Omitted on a re-add of an existing URL — use rotate-secret.)
      this.process.stdout.write(
        `\nsigning secret (shown once — configure it in your receiver's verifier):\n  ${created.signingSecret}\n`,
      );
    }
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

// `wbhk replay-destinations rotate-secret <id>` — mint a fresh Standard Webhooks signing secret for the
// destination (S3 Slice 2). The new secret is shown ONCE; the prior key keeps verifying during a bounded
// overlap so the receiver can reconfigure with no downtime.
export const replayDestinationsRotateSecretCommand = buildCommand<
  GlobalFlags,
  [string],
  AppContext
>({
  async func(this: AppContext, flags, destinationId) {
    const client = await authedClient(this, flags);
    if (client instanceof NotLoggedInError) return client;
    const { format } = resolveGlobals(this, flags);
    const rotated = await client.replayDestinationsRotateSigningSecret(destinationId);
    if (format === "json") {
      this.process.stdout.write(`${renderJson(rotated)}\n`);
      return;
    }
    this.process.stdout.write(
      `rotated the signing secret for ${rotated.destinationId} (key ${rotated.keyId}).\n` +
        `\nnew signing secret (shown once):\n  ${rotated.signingSecret}\n` +
        `the previous secret keeps verifying during a brief overlap.\n`,
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
  docs: { brief: "rotate a replay destination's signing secret" },
});

// `wbhk replay-destinations list-secrets <id>` — the destination's signing-secret metadata (id/status/
// created), never the secret value.
export const replayDestinationsListSecretsCommand = buildCommand<GlobalFlags, [string], AppContext>(
  {
    async func(this: AppContext, flags, destinationId) {
      const client = await authedClient(this, flags);
      if (client instanceof NotLoggedInError) return client;
      const { format } = resolveGlobals(this, flags);
      const items = await client.replayDestinationsListSigningSecrets(destinationId);
      if (format === "json") {
        this.process.stdout.write(`${renderJson({ items })}\n`);
        return;
      }
      this.process.stdout.write(
        items.length === 0
          ? "no signing secrets.\n"
          : `${items
              .map((s) => `${s.id}  ${s.status}  ${new Date(s.createdAt).toISOString()}`)
              .join("\n")}\n`,
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
    docs: { brief: "list a replay destination's signing-secret metadata" },
  },
);

// `wbhk replay-destinations enable <id>` — clear a persistent-failure auto-disable so the destination
// resumes being a delivery target (S3 Slice 3). Owed deliveries resume on the DO's next wake.
export const replayDestinationsEnableCommand = buildCommand<GlobalFlags, [string], AppContext>({
  async func(this: AppContext, flags, destinationId) {
    const client = await authedClient(this, flags);
    if (client instanceof NotLoggedInError) return client;
    const { format } = resolveGlobals(this, flags);
    const record = await client.replayDestinationsEnable(destinationId);
    this.process.stdout.write(
      format === "json" ? `${renderJson(record)}\n` : `${renderReplayDestination(record)}\n`,
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
  docs: { brief: "re-enable an auto-disabled replay destination" },
});

// `wbhk replay-destinations set-ordered <id> <on|off>` — set strict-FIFO delivery. The mode is a REQUIRED
// positional (not a boolean flag, which stricli treats as optional-defaulting-false — a bare invocation would
// silently force best-effort). `on` = strict FIFO: deliver in order, but a stuck delivery HEAD-OF-LINE-BLOCKS
// newer ones until it succeeds or dead-letters. `off` = the best-effort default: each delivery retries
// independently.
function parseOrderedMode(value: string): boolean {
  const v = value.toLowerCase();
  if (v === "on" || v === "strict" || v === "true") return true;
  if (v === "off" || v === "best-effort" || v === "false") return false;
  throw new Error(`expected "on" or "off", got "${value}"`);
}
export const replayDestinationsSetOrderedCommand = buildCommand<
  GlobalFlags,
  [string, boolean],
  AppContext
>({
  async func(this: AppContext, flags, destinationId, ordered) {
    const client = await authedClient(this, flags);
    if (client instanceof NotLoggedInError) return client;
    const { format } = resolveGlobals(this, flags);
    const record = await client.replayDestinationsSetOrdered(destinationId, ordered);
    this.process.stdout.write(
      format === "json" ? `${renderJson(record)}\n` : `${renderReplayDestination(record)}\n`,
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
        {
          parse: parseOrderedMode,
          brief: "on = strict FIFO (head-of-line blocking); off = best-effort (default)",
          placeholder: "mode",
        },
      ],
    },
    flags: { ...globalFlags },
  },
  docs: { brief: "set strict-FIFO (ordered) delivery on/off for a destination" },
});
