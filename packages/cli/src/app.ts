import {
  buildApplication,
  buildCommand,
  buildRouteMap,
  text_en,
  type Application,
  type ApplicationText,
  type Command,
} from "@stricli/core";

import type { AppContext } from "./context.js";
import { CliError, NotImplementedError } from "./errors.js";
import { EXIT } from "./output/exit-codes.js";
import { formatCliError } from "./output/format.js";

// Kept in sync with package.json; the bundle/build step injects the real value.
export const VERSION = "0.0.0";

// Where each contract capability surfaces in the CLI command tree. events.tail is the
// `listen` tunnel; events.replay is `replay`; the rest map name→path directly. Asserted
// against CAPABILITIES in app.test — a new capability fails the build until it is surfaced.
export const CAPABILITY_COMMANDS: Record<string, readonly string[]> = {
  "endpoints.list": ["endpoints", "list"],
  "endpoints.get": ["endpoints", "get"],
  "events.list": ["events", "list"],
  "events.get": ["events", "get"],
  "events.tail": ["listen"],
  "events.replay": ["replay"],
  "audit.verify": ["audit", "verify"],
};

// Every command is registered now (so the surface is complete and parity holds) but returns
// a clear NotImplementedError until its slice lands. Returning an Error (vs throwing) is
// stricli's "safe command error" path → formatted via commandErrorResult below.

/** A capability-backed command stub, carrying the shared --output flag. */
function capabilityStub(path: readonly string[], slice: string): Command<AppContext> {
  return buildCommand<{ output: "text" | "json" }, [], AppContext>({
    func: () => new NotImplementedError(path, slice),
    parameters: {
      flags: {
        output: {
          kind: "enum",
          values: ["text", "json"],
          brief: "output format",
          default: "text",
        },
      },
    },
    docs: { brief: `${path.join(" ")} — lands in ${slice}` },
  });
}

/** An auth-seam command stub (login/whoami) — not a capability, no --output flag. */
function authStub(path: readonly string[], slice: string): Command<AppContext> {
  return buildCommand<Record<never, never>, [], AppContext>({
    func: () => new NotImplementedError(path, slice),
    parameters: {},
    docs: { brief: `${path.join(" ")} — lands in ${slice}` },
  });
}

const endpointsRoute = buildRouteMap({
  routes: {
    list: capabilityStub(["endpoints", "list"], "slice 10"),
    get: capabilityStub(["endpoints", "get"], "slice 10"),
  },
  docs: { brief: "inspect your endpoints" },
});

const eventsRoute = buildRouteMap({
  routes: {
    list: capabilityStub(["events", "list"], "slice 10"),
    get: capabilityStub(["events", "get"], "slice 10"),
  },
  docs: { brief: "inspect captured events" },
});

const auditRoute = buildRouteMap({
  routes: {
    verify: capabilityStub(["audit", "verify"], "slice 10"),
  },
  docs: { brief: "verify the tamper-evident audit chain" },
});

const root = buildRouteMap({
  routes: {
    login: authStub(["login"], "slice 9"),
    whoami: authStub(["whoami"], "slice 9"),
    endpoints: endpointsRoute,
    events: eventsRoute,
    audit: auditRoute,
    listen: capabilityStub(["listen"], "slice 12"),
    replay: capabilityStub(["replay"], "slice 12"),
  },
  docs: { brief: "webhook.co — capture, inspect, and replay webhooks" },
});

// Route both command-error paths through the one formatter so a CliError prints its
// voice-compliant message (never a stack trace) and ansiColor is threaded to the single
// place that will eventually style output.
const appText: ApplicationText = {
  ...text_en,
  commandErrorResult: (err: Error, ansiColor: boolean): string =>
    formatCliError(err, { color: ansiColor }),
  exceptionWhileRunningCommand: (exc: unknown, ansiColor: boolean): string =>
    formatCliError(exc, { color: ansiColor }),
};

export const app: Application<AppContext> = buildApplication(root, {
  name: "wbhk",
  versionInfo: { currentVersion: VERSION },
  determineExitCode: (exc: unknown): number =>
    exc instanceof CliError ? exc.exitCode : EXIT.UNEXPECTED,
  scanner: { caseStyle: "allow-kebab-for-camel" },
  localization: { text: appText },
});
