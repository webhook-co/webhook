import { CliError } from "../errors.js";
import { EXIT } from "../output/exit-codes.js";

// Typed, instance-checkable errors for the credential store — now first-class CliErrors, so each carries
// a STABLE exit code (USAGE) and an on-voice `userMessage` the app formatter prints (never a stack trace).
// Messages never include a secret; a config path is not a secret and is included where it helps the user
// fix the problem. (`instanceof ConfigError` still works for store-internal branching.)
export abstract class ConfigError extends CliError {}

export class ConfigNotFoundError extends ConfigError {
  readonly exitCode = EXIT.USAGE;
  readonly userMessage = "no cli config file found — run `wbhk login` to create one.";
  constructor() {
    super("no cli config file found");
    this.name = "ConfigNotFoundError";
  }
}

export class CorruptConfigError extends ConfigError {
  readonly exitCode = EXIT.USAGE;
  readonly userMessage: string;
  constructor(detail: string) {
    super(`cli config file is unreadable: ${detail}`);
    this.name = "CorruptConfigError";
    this.userMessage = `cli config file is unreadable (${detail}) — fix or remove it, then run \`wbhk login\` again.`;
  }
}

export class InsecureConfigPermissionsError extends ConfigError {
  readonly exitCode = EXIT.USAGE;
  readonly userMessage: string;
  constructor(
    readonly mode: number,
    readonly path: string,
  ) {
    super(
      `cli config file permissions are too open (mode ${mode.toString(8)}); ` +
        `expected 600. fix it with: chmod 600 ${path}`,
    );
    this.name = "InsecureConfigPermissionsError";
    this.userMessage =
      `cli config file permissions are too open (mode ${mode.toString(8)}; expected 600) — ` +
      `fix it with: chmod 600 ${path}`;
  }
}

export class SecureStorageRequiredError extends ConfigError {
  readonly exitCode = EXIT.USAGE;
  readonly userMessage =
    "secure credential storage is required but no secure backend is available — " +
    "use WBHK_API_KEY instead of writing a plaintext config file.";
  constructor() {
    super(
      "secure credential storage is required but no secure backend is available; " +
        "use WBHK_API_KEY instead of writing a plaintext config file",
    );
    this.name = "SecureStorageRequiredError";
  }
}

export class KeychainUnavailableError extends ConfigError {
  readonly exitCode = EXIT.USAGE;
  readonly userMessage =
    "no OS keychain is available for secure credential storage — install the keychain helper for your " +
    "platform, or pass --insecure-storage to fall back to the 0600 config file.";
  constructor() {
    super("no OS keychain available for secure credential storage");
    this.name = "KeychainUnavailableError";
  }
}

export class BackendNotWritableError extends ConfigError {
  readonly exitCode = EXIT.USAGE;
  readonly userMessage: string;
  constructor(readonly backendId: string) {
    super(`credential backend "${backendId}" is read-only`);
    this.name = "BackendNotWritableError";
    this.userMessage =
      `credential backend "${backendId}" is read-only and no writable credential store is available — ` +
      `set WBHK_API_KEY to authenticate without a stored credential.`;
  }
}
