// Anonymous, opt-out usage telemetry (DIST-14). What's collected is intentionally minimal + anonymous: the
// cli version, OS + arch, the COMMAND NAME (never its args/values), the outcome + exit code, and a COARSE
// duration bucket. NEVER endpoint ids, payloads, tokens, profile names, URLs, cwd, or any PII. Opt out with
// `WBHK_TELEMETRY=0` / `DO_NOT_TRACK=1` / `wbhk telemetry off`. The send (io.ts) is fire-and-forget +
// best-effort — it never blocks or fails a command. The pieces here are pure so the privacy surface is tested.

/** Where anonymous events are sent — a cookieless collector on the separate ingestion apex. */
export const TELEMETRY_ENDPOINT = "https://telemetry.wbhk.my/e";

/** The one-time, on-first-run privacy notice (stderr). Concise + self-contained — states what's collected
 *  and how to opt out, with no URL to 404. */
export const TELEMETRY_NOTICE =
  "wbhk collects anonymous usage telemetry (which commands, cli version, OS/arch — never your data, args, " +
  "or credentials). opt out anytime: `wbhk telemetry off` (or set WBHK_TELEMETRY=0).\n";

export interface TelemetryEvent {
  /** cli version (e.g. "0.1.2", or "0.0.0" for a dev build). */
  readonly v: string;
  /** process.platform (darwin|linux|win32). */
  readonly os: string;
  /** process.arch (arm64|x64|…). */
  readonly arch: string;
  /** A safe command label — a known command/subcommand name only, NEVER a positional arg/value. */
  readonly command: string;
  readonly outcome: "ok" | "error";
  /** process exit code. */
  readonly exit: number;
  /** A coarse duration bucket (not a precise timing). */
  readonly duration: string;
}

const OFF_VALUES = new Set(["0", "false", "off", "no"]);
const ON_VALUES = new Set(["1", "true", "on", "yes"]);

function isTruthy(v: string | undefined): boolean {
  return v !== undefined && v !== "" && !OFF_VALUES.has(v.toLowerCase());
}

/** Common CI markers — telemetry is auto-disabled in CI (it's noise, and CI isn't a user). */
function isCI(env: Record<string, string | undefined>): boolean {
  return (
    isTruthy(env.CI) ||
    env.GITHUB_ACTIONS !== undefined ||
    env.GITLAB_CI !== undefined ||
    env.BUILDKITE !== undefined ||
    env.CIRCLECI !== undefined ||
    env.TF_BUILD !== undefined
  );
}

/** Resolve whether telemetry is enabled. Opt-OUT model (enabled by default), disabled by: an explicit
 *  `WBHK_TELEMETRY` value (which also explicitly ENABLES, overriding everything), `DO_NOT_TRACK`, a stored
 *  `wbhk telemetry off`, or any CI environment. */
export function resolveTelemetryEnabled(opts: {
  env: Record<string, string | undefined>;
  stored: boolean | undefined;
}): boolean {
  const explicit = opts.env.WBHK_TELEMETRY;
  if (explicit !== undefined && explicit !== "") {
    const v = explicit.toLowerCase();
    if (OFF_VALUES.has(v)) return false;
    if (ON_VALUES.has(v)) return true; // explicit enable overrides CI / DO_NOT_TRACK / stored
  }
  if (isTruthy(opts.env.DO_NOT_TRACK)) return false;
  if (opts.stored === false) return false;
  if (isCI(opts.env)) return false;
  return true;
}

// The public command surface → which subcommands are safe to record. We emit ONLY these known names, so a
// positional arg (an endpoint id, event id, …) can never be sent as the "command".
const KNOWN_COMMANDS: Record<string, ReadonlySet<string>> = {
  login: new Set(),
  logout: new Set(),
  whoami: new Set(),
  doctor: new Set(),
  upgrade: new Set(),
  listen: new Set(),
  replay: new Set(),
  telemetry: new Set(["on", "off", "status"]),
  endpoints: new Set(["list", "get"]),
  events: new Set(["list", "get", "payload"]),
  audit: new Set(["verify"]),
  profile: new Set(["use", "current", "list", "remove", "add"]),
  completion: new Set(["bash", "zsh", "fish"]),
};

/** A SAFE command label from argv: the top-level command, plus a known subcommand for grouped commands —
 *  and NOTHING else. Unknown input → "other"; help/version → those. Positional args are NEVER emitted (a
 *  second token is recorded only if it's an allow-listed subcommand, so an id/value can't leak). Note: a
 *  flag VALUE before the subcommand (`endpoints --profile p list`) can mislabel the subcommand, but never
 *  leaks the value — it only records a name when that name is in the allow-list. */
export function commandLabel(argv: readonly string[]): string {
  const tokens = argv.filter((t) => !t.startsWith("-"));
  const top = tokens[0];
  if (top === undefined) {
    if (argv.includes("--help") || argv.includes("-h")) return "help";
    if (argv.includes("--version") || argv.includes("-v")) return "version";
    return "none";
  }
  const subs = KNOWN_COMMANDS[top];
  if (subs === undefined) return "other";
  const sub = tokens[1];
  return sub !== undefined && subs.has(sub) ? `${top} ${sub}` : top;
}

/** A coarse duration bucket — never a precise timing. */
export function durationBucket(ms: number): string {
  if (ms < 100) return "<100ms";
  if (ms < 1000) return "<1s";
  if (ms < 10_000) return "<10s";
  if (ms < 60_000) return "<1m";
  return ">=1m";
}

/** Assemble the anonymous event from already-safe inputs. */
export function buildTelemetryEvent(opts: {
  version: string;
  platform: string;
  arch: string;
  argv: readonly string[];
  exitCode: number;
  durationMs: number;
}): TelemetryEvent {
  return {
    v: opts.version,
    os: opts.platform,
    arch: opts.arch,
    command: commandLabel(opts.argv),
    outcome: opts.exitCode === 0 ? "ok" : "error",
    exit: opts.exitCode,
    duration: durationBucket(opts.durationMs),
  };
}
