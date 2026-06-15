// Public surface of @webhook-co/cli for programmatic use and tests. The executable entry
// is src/bin.ts (the `wbhk` bin); this barrel re-exports the app and its seams.
export { app, VERSION, CAPABILITY_COMMANDS } from "./app.js";
export {
  buildContext,
  makeTestContext,
  REQUIRE_SECURE_STORAGE_VAR,
  type AppContext,
  type HostProcess,
} from "./context.js";
export {
  resolveStore,
  type CredentialStore,
  type CredentialBackend,
  type StoragePolicy,
} from "./config/store.js";
export { ENV_API_KEY_VAR } from "./config/env-store.js";
export {
  EXIT,
  CAPABILITY_EXIT,
  exitCodeForCapabilityError,
  normalizeStricliExitCode,
} from "./output/exit-codes.js";
export { CliError, NotImplementedError } from "./errors.js";
export { type OutputFormat, resolveFormat, renderJson, redactCredential } from "./output/format.js";
