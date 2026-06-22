import {
  buildApplication,
  buildRouteMap,
  text_en,
  type Application,
  type ApplicationText,
} from "@stricli/core";

import { auditVerifyCommand } from "./commands/audit.js";
import { endpointsGetCommand, endpointsListCommand } from "./commands/endpoints.js";
import { eventsGetCommand, eventsListCommand, eventsPayloadCommand } from "./commands/events.js";
import { listenCommand } from "./commands/listen.js";
import { loginCommand } from "./commands/login.js";
import { replayCommand } from "./commands/replay.js";
import { whoamiCommand } from "./commands/whoami.js";
import type { AppContext } from "./context.js";
import { CliError } from "./errors.js";
import { EXIT } from "./output/exit-codes.js";
import { formatCliError, formatUnknownCommand } from "./output/format.js";

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
  "events.getPayload": ["events", "payload"],
  "events.tail": ["listen"],
  "events.replay": ["replay"],
  "audit.verify": ["audit", "verify"],
};

const endpointsRoute = buildRouteMap({
  routes: {
    list: endpointsListCommand,
    get: endpointsGetCommand,
  },
  docs: { brief: "inspect your endpoints" },
});

const eventsRoute = buildRouteMap({
  routes: {
    list: eventsListCommand,
    get: eventsGetCommand,
    payload: eventsPayloadCommand,
  },
  docs: { brief: "inspect captured events" },
});

const auditRoute = buildRouteMap({
  routes: {
    verify: auditVerifyCommand,
  },
  docs: { brief: "verify the tamper-evident audit chain" },
});

const root = buildRouteMap({
  routes: {
    login: loginCommand,
    whoami: whoamiCommand,
    endpoints: endpointsRoute,
    events: eventsRoute,
    audit: auditRoute,
    listen: listenCommand,
    replay: replayCommand,
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
  // An unknown command suggests the closest match (stricli supplies `corrections`) or points at --help.
  noCommandRegisteredForInput: ({ input, corrections }): string =>
    formatUnknownCommand({ input, corrections }),
};

export const app: Application<AppContext> = buildApplication(root, {
  name: "wbhk",
  versionInfo: { currentVersion: VERSION },
  determineExitCode: (exc: unknown): number =>
    exc instanceof CliError ? exc.exitCode : EXIT.UNEXPECTED,
  scanner: { caseStyle: "allow-kebab-for-camel" },
  localization: { text: appText },
});
