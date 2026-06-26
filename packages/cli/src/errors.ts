import { CAPABILITY_EXIT, EXIT } from "./output/exit-codes.js";

// CLI-level errors carry a stable exit code and a voice-compliant, single-paragraph
// user message (no stack trace, no ANSI). stricli's determineExitCode + error formatting
// read these so failures are scriptable and on-voice.
export abstract class CliError extends Error {
  abstract readonly exitCode: number;
  abstract readonly userMessage: string;
}

export class NotImplementedError extends CliError {
  readonly exitCode = EXIT.NOT_IMPLEMENTED;
  readonly userMessage: string;

  constructor(commandPath: readonly string[], slice: string) {
    const command = ["wbhk", ...commandPath].join(" ");
    super(`command not implemented: ${command}`);
    this.name = "NotImplementedError";
    this.userMessage = `\`${command}\` isn't built yet — it lands in ${slice}. follow the changelog for progress.`;
  }
}

/** `wbhk login` invoked without a key in any accepted form — a usage error (exit 2). */
export class MissingApiKeyError extends CliError {
  readonly exitCode = EXIT.USAGE;
  constructor(readonly userMessage: string) {
    super(userMessage);
    this.name = "MissingApiKeyError";
  }
}

/** A destructive command (`endpoints delete` / `endpoints rotate`) ran without `--yes` and either could
 *  not prompt (non-TTY) or the prompt was declined. A usage error (exit 2) so a script that forgot `--yes`
 *  — or a human who said no — sees a clear non-zero, and nothing was mutated. */
export class ConfirmationError extends CliError {
  readonly exitCode = EXIT.USAGE;
  constructor(readonly userMessage: string) {
    super(userMessage);
    this.name = "ConfirmationError";
  }
}

/** A command needed an interactive-or-piped input (e.g. a provider secret) but got none — usage (exit 2). */
export class MissingInputError extends CliError {
  readonly exitCode = EXIT.USAGE;
  constructor(readonly userMessage: string) {
    super(userMessage);
    this.name = "MissingInputError";
  }
}

/** A command needs a credential but none is stored (and none in WBHK_API_KEY). Maps to the same
 *  "not authenticated" exit code as a server 401, so automation branches on one signal. */
export class NotLoggedInError extends CliError {
  readonly exitCode = CAPABILITY_EXIT.UNAUTHORIZED;
  readonly userMessage = "not logged in — run `wbhk login` first, or set WBHK_API_KEY.";
  constructor() {
    super("not logged in");
    this.name = "NotLoggedInError";
  }
}

/** A `--api-url` / WBHK_API_URL override that isn't an https:// URL (http:// only for loopback dev).
 *  Sending the bearer key over a plaintext or attacker-chosen origin would leak a live credential. */
export class InvalidApiUrlError extends CliError {
  readonly exitCode = EXIT.USAGE;
  readonly userMessage: string;
  constructor(value: string) {
    super(`invalid api url: ${value}`);
    this.name = "InvalidApiUrlError";
    this.userMessage = `invalid api url \`${value}\` — must be an https:// URL (http:// is allowed only for localhost).`;
  }
}

/** A profile name (`--profile` / WBHK_PROFILE / the persisted active profile) that collides with a JS
 *  object's reserved keys. Profiles key an in-memory map, so `__proto__` would make a write silently
 *  no-op (the bracket-write hits the prototype, not an own key) and `constructor`/`prototype` would
 *  shadow — reject loudly rather than report a phantom "logged in". */
export class InvalidProfileNameError extends CliError {
  readonly exitCode = EXIT.USAGE;
  readonly userMessage: string;
  constructor(value: string) {
    super(`invalid profile name: ${value}`);
    this.name = "InvalidProfileNameError";
    this.userMessage = `invalid profile name \`${value}\` — \`__proto__\`, \`constructor\`, and \`prototype\` are reserved. choose another name.`;
  }
}

/** A `--tunnel-url` / WBHK_TUNNEL_URL override that isn't a wss:// URL (ws:// only for loopback dev).
 *  Same reasoning as InvalidApiUrlError — the bearer key rides the tunnel upgrade handshake. */
export class InvalidTunnelUrlError extends CliError {
  readonly exitCode = EXIT.USAGE;
  readonly userMessage: string;
  constructor(value: string) {
    super(`invalid tunnel url: ${value}`);
    this.name = "InvalidTunnelUrlError";
    this.userMessage = `invalid tunnel url \`${value}\` — must be a wss:// URL (ws:// is allowed only for localhost).`;
  }
}

/** A `--forward` target that isn't an http(s):// loopback URL. Replay is replay-to-LOCALHOST: sending a
 *  captured payload + its provider signature to a non-local host would leak it off the machine. */
export class InvalidForwardUrlError extends CliError {
  readonly exitCode = EXIT.USAGE;
  readonly userMessage: string;
  constructor(value: string) {
    super(`invalid forward url: ${value}`);
    this.name = "InvalidForwardUrlError";
    this.userMessage = `invalid forward url \`${value}\` — must be an http:// or https:// URL pointing at localhost (127.0.0.1 / ::1).`;
  }
}

/** A `--auth-url` / WBHK_AUTH_URL override that isn't an https:// URL (http:// only for loopback dev).
 *  The OAuth flow carries codes/tokens, so a plaintext or attacker-chosen issuer would leak credentials. */
export class InvalidAuthUrlError extends CliError {
  readonly exitCode = EXIT.USAGE;
  readonly userMessage: string;
  constructor(value: string) {
    super(`invalid auth url: ${value}`);
    this.name = "InvalidAuthUrlError";
    this.userMessage = `invalid auth url \`${value}\` — must be an https:// URL (http:// is allowed only for localhost).`;
  }
}

/** An OAuth error from the issuer (a 400 `{error, error_description?}`, or a transport failure). Maps to
 *  the same "not authenticated" exit as a 401, so automation branches on one signal. The `code` is the
 *  closed OAuth error taxonomy (invalid_grant, access_denied, …) used by the login/refresh flows. */
export class OAuthError extends CliError {
  readonly exitCode = CAPABILITY_EXIT.UNAUTHORIZED;
  readonly userMessage: string;
  constructor(
    readonly code: string,
    detail?: string,
  ) {
    super(`oauth error: ${code}${detail ? ` (${detail})` : ""}`);
    this.name = "OAuthError";
    this.userMessage = `authentication failed (${code}) — run \`wbhk login\` again.`;
  }
}
