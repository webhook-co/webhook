import { buildCommand } from "@stricli/core";

import { createApiClient, ENV_API_URL_VAR, resolveApiBaseUrl } from "../api-client.js";
import type { AppContext } from "../context.js";
import { applyEdit, decodeEditableBody, editorFromEnv } from "../edit.js";
import { NotLoggedInError } from "../errors.js";
import { forwardToLocalhost, isDelivered, parseForwardTarget } from "../forward.js";
import {
  announceActiveProfile,
  globalFlags,
  resolveGlobals,
  resolveProfile,
  type GlobalFlags,
} from "../global-flags.js";
import { bindAuth } from "../oauth/auth-binding.js";
import { colorize } from "../output/color.js";
import { CAPABILITY_EXIT, EXIT } from "../output/exit-codes.js";
import { renderJson } from "../output/format.js";

// `wbhk replay <eventId> --forward <localhost-url>` — re-deliver a captured event to a local dev
// server. The CLI fetches the event's captured headers + exact body, POSTs them to localhost
// (signature-preserving: exact bytes + the original webhook-* headers), and on a local 2xx records
// the delivery_attempt server-side (events.replay, idempotent). A non-2xx or an unreachable target
// exits non-zero and records nothing. `--edit` opens the body in $EDITOR first (to tweak a payload);
// the original signature then no longer matches the edited body (we can't re-sign — it's the sender's
// secret), so we forward it with a warning rather than silently ship something the handler will reject.

interface ReplayFlags extends GlobalFlags {
  forward?: string;
  edit: boolean;
}

export const replayCommand = buildCommand<ReplayFlags, [string], AppContext>({
  async func(this: AppContext, flags, eventId) {
    const profile = await resolveProfile(this, flags);
    announceActiveProfile(this, profile);
    const cred = await this.store.get(profile);
    if (cred === null) return new NotLoggedInError();
    if (flags.forward === undefined) {
      this.process.stderr.write(
        "replay requires --forward <localhost-url> — it re-delivers the event to your local server.\n",
      );
      this.process.exitCode = EXIT.USAGE;
      return;
    }
    parseForwardTarget(flags.forward); // throws InvalidForwardUrlError (usage) on a non-loopback target

    const apiBaseUrl = resolveApiBaseUrl({
      flag: flags.apiUrl,
      env: this.process.env?.[ENV_API_URL_VAR],
      stored: await this.store.getApiBaseUrl(profile),
    });
    const { bearer, refreshAuth } = await bindAuth({
      cred,
      profile,
      store: this.store,
      fetch: this.io.fetch,
      env: this.process.env,
    });
    const client = createApiClient({
      baseUrl: apiBaseUrl,
      apiKey: bearer,
      fetch: this.io.fetch,
      refreshAuth,
    });

    // Captured headers (signature fidelity) + exact body bytes. A bad/cross-org id surfaces as the
    // api's NOT_FOUND (mapped to the exit code) before we ever touch localhost.
    const event = await client.eventsGet(eventId);
    const { body } = await client.eventsGetPayload(eventId);

    // --edit: open the captured body in $EDITOR before forwarding, so you can tweak a payload to exercise
    // a local handler. The captured headers (incl. the ORIGINAL provider signature) still pass through
    // verbatim — we can't recompute that signature (it's the third-party sender's secret, never ours) — so
    // an edited body won't verify; we warn rather than silently ship a payload the handler will reject.
    let forwardBody = body;
    if (flags.edit) {
      const editor = editorFromEnv(this.process.env ?? {});
      if (editor === undefined) {
        this.process.stderr.write("--edit needs an editor — set $VISUAL or $EDITOR.\n");
        this.process.exitCode = EXIT.USAGE;
        return;
      }
      const text = decodeEditableBody(body);
      if (text === null) {
        this.process.stderr.write(
          "--edit only supports a text payload — this event's body isn't valid UTF-8.\n",
        );
        this.process.exitCode = EXIT.USAGE;
        return;
      }
      // A save that differs only by a trailing newline (the editor's doing) is NOT a real edit → forward
      // the original bytes exactly, like a plain replay. Only a genuine change re-encodes + warns.
      const { text: finalText, changed } = applyEdit(text, await this.io.editText(text, editor));
      if (changed) {
        forwardBody = new TextEncoder().encode(finalText);
        this.process.stderr.write(
          "note: the payload was edited — the original webhook signature no longer matches it, so a " +
            "local server that verifies signatures will reject it.\n",
        );
      }
    }

    const outcome = await forwardToLocalhost(
      { fetch: this.io.fetch, now: () => Date.now() },
      { targetUrl: flags.forward, headers: event.headers, body: forwardBody },
    );
    const { format, color } = resolveGlobals(this, flags);

    if (!outcome.ok) {
      this.process.stderr.write(`could not reach ${flags.forward}: ${outcome.reason}\n`);
      this.process.exitCode = CAPABILITY_EXIT.TARGET_UNREACHABLE;
      return;
    }
    if (!isDelivered(outcome)) {
      this.process.stderr.write(
        `${flags.forward} returned ${outcome.status} — recording skipped (replay records only a local 2xx).\n`,
      );
      this.process.exitCode = EXIT.UNEXPECTED;
      return;
    }

    // Delivered: record the attempt server-side. A fresh session + idempotency key — a one-shot replay,
    // so re-running the command is a deliberately new attempt.
    const attempt = await client.eventsReplay({
      eventId,
      target: { kind: "localhost-tunnel", sessionId: crypto.randomUUID() },
      idempotencyKey: crypto.randomUUID(),
    });

    if (format === "json") {
      this.process.stdout.write(
        `${renderJson({ delivered: true, status: outcome.status, latencyMs: outcome.latencyMs, attempt })}\n`,
      );
    } else {
      const ok = colorize("delivered", "green", color);
      this.process.stdout.write(
        `${ok} event ${eventId} → ${flags.forward} · ${outcome.status} · ${outcome.latencyMs}ms · recorded ${attempt.id}\n`,
      );
    }
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [{ parse: (v: string) => v, brief: "the event id", placeholder: "eventId" }],
    },
    flags: {
      ...globalFlags,
      forward: {
        kind: "parsed",
        parse: (v: string) => v,
        brief: "local URL to deliver to, e.g. http://localhost:3000/webhooks",
        optional: true,
      },
      edit: {
        kind: "boolean",
        brief:
          "open the payload in $EDITOR before forwarding (the original signature won't re-verify)",
        default: false,
      },
    },
  },
  docs: {
    brief: "replay a captured event to your local server (--forward; --edit to tweak the payload)",
  },
});
