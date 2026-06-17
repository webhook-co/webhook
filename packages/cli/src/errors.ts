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
