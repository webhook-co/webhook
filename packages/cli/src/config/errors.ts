// Typed, instance-checkable errors for the credential store. Surfaces map these to
// voice-compliant messages and stable exit codes. Messages never include a secret;
// a config path is not a secret and is included where it helps the user fix the problem.

export class ConfigError extends Error {}

export class ConfigNotFoundError extends ConfigError {
  constructor() {
    super("no cli config file found");
    this.name = "ConfigNotFoundError";
  }
}

export class CorruptConfigError extends ConfigError {
  constructor(detail: string) {
    super(`cli config file is unreadable: ${detail}`);
    this.name = "CorruptConfigError";
  }
}

export class InsecureConfigPermissionsError extends ConfigError {
  constructor(
    readonly mode: number,
    readonly path: string,
  ) {
    super(
      `cli config file permissions are too open (mode ${mode.toString(8)}); ` +
        `expected 600. fix it with: chmod 600 ${path}`,
    );
    this.name = "InsecureConfigPermissionsError";
  }
}

export class SecureStorageRequiredError extends ConfigError {
  constructor() {
    super(
      "secure credential storage is required but no secure backend is available; " +
        "use WBHK_API_KEY instead of writing a plaintext config file",
    );
    this.name = "SecureStorageRequiredError";
  }
}

export class BackendNotWritableError extends ConfigError {
  constructor(readonly backendId: string) {
    super(`credential backend "${backendId}" is read-only`);
    this.name = "BackendNotWritableError";
  }
}
