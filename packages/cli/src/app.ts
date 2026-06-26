import {
  buildApplication,
  buildRouteMap,
  text_en,
  type Application,
  type ApplicationText,
} from "@stricli/core";

import { auditVerifyCommand } from "./commands/audit.js";
import { completionRoute } from "./commands/completion.js";
import { doctorCommand } from "./commands/doctor.js";
import {
  endpointsAddProviderSecretCommand,
  endpointsCreateCommand,
  endpointsDeleteCommand,
  endpointsGetCommand,
  endpointsListCommand,
  endpointsListProviderSecretsCommand,
  endpointsRevokeProviderSecretCommand,
  endpointsRotateCommand,
} from "./commands/endpoints.js";
import { eventsGetCommand, eventsListCommand, eventsPayloadCommand } from "./commands/events.js";
import { listenCommand } from "./commands/listen.js";
import { loginCommand } from "./commands/login.js";
import { logoutCommand } from "./commands/logout.js";
import { profileRoute } from "./commands/profile.js";
import { replayCommand } from "./commands/replay.js";
import { telemetryRoute } from "./commands/telemetry.js";
import { upgradeCommand } from "./commands/upgrade.js";
import { whoamiCommand } from "./commands/whoami.js";
import type { AppContext } from "./context.js";
import { CliError } from "./errors.js";
import { EXIT } from "./output/exit-codes.js";
import { formatCliError, formatUnknownCommand } from "./output/format.js";
import { VERSION } from "./version.js";

// Re-exported so `--version`/tests read it from one place; single-sourced in version.ts.
export { VERSION };

// Where each contract capability surfaces in the CLI command tree. events.tail is the
// `listen` tunnel; events.replay is `replay`; the rest map name→path directly. Asserted
// against CAPABILITIES in app.test — a new capability fails the build until it is surfaced.
export const CAPABILITY_COMMANDS: Record<string, readonly string[]> = {
  "endpoints.list": ["endpoints", "list"],
  "endpoints.get": ["endpoints", "get"],
  "endpoints.create": ["endpoints", "create"],
  "endpoints.delete": ["endpoints", "delete"],
  "endpoints.rotate": ["endpoints", "rotate"],
  "endpoints.addProviderSecret": ["endpoints", "add-provider-secret"],
  "endpoints.listProviderSecrets": ["endpoints", "list-provider-secrets"],
  "endpoints.revokeProviderSecret": ["endpoints", "revoke-provider-secret"],
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
    create: endpointsCreateCommand,
    delete: endpointsDeleteCommand,
    rotate: endpointsRotateCommand,
    "add-provider-secret": endpointsAddProviderSecretCommand,
    "list-provider-secrets": endpointsListProviderSecretsCommand,
    "revoke-provider-secret": endpointsRevokeProviderSecretCommand,
  },
  docs: { brief: "inspect and manage your endpoints" },
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
    logout: logoutCommand,
    whoami: whoamiCommand,
    profile: profileRoute,
    doctor: doctorCommand,
    endpoints: endpointsRoute,
    events: eventsRoute,
    audit: auditRoute,
    listen: listenCommand,
    replay: replayCommand,
    upgrade: upgradeCommand,
    telemetry: telemetryRoute,
    completion: completionRoute,
  },
  docs: { brief: "webhook.co — capture, inspect, and replay webhooks" },
});

// Route both command-error paths through the one formatter so a CliError prints its
// voice-compliant message (never a stack trace). Error output is deliberately plain — stricli passes an
// ansiColor flag to these callbacks, but we don't style errors, so it's ignored.
const appText: ApplicationText = {
  ...text_en,
  commandErrorResult: (err: Error): string => formatCliError(err),
  exceptionWhileRunningCommand: (exc: unknown): string => formatCliError(exc),
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
