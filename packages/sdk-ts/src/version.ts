// The SDK version, single-sourced for the User-Agent.
//
// STAMPED AT RELEASE: release-sdk-ts.yml rewrites this literal from the `sdk-ts-vX.Y.Z` tag, alongside
// `npm version`. A dev/test run leaves it "0.0.0". A drift test (version.test.ts) asserts it always equals
// package.json's version, so a stamped release can never ship a User-Agent that LIES about which version is
// running — which would make the server's advisory worse than useless (it would advise the wrong people).
export const SDK_VERSION = "0.0.0";

/**
 * The User-Agent the server uses to recognise this client and, when we're behind, to answer with an
 * advisory header on a response the caller already asked for (see `onAdvisory`). It carries the client id,
 * the version, and the runtime — nothing about the caller, their org, or their key.
 */
export function userAgent(runtime = describeRuntime()): string {
  return `webhook-co-js/${SDK_VERSION} (${runtime})`;
}

/** Best-effort runtime description. Must never throw: this runs in Node, Bun, Deno, Workers and browsers. */
function describeRuntime(): string {
  try {
    const proc = (globalThis as { process?: { versions?: { node?: string }; platform?: string } })
      .process;
    if (proc?.versions?.node) return `node/${proc.versions.node}; ${proc.platform ?? "unknown"}`;
    const nav = (globalThis as { navigator?: { userAgent?: string } }).navigator;
    if (nav?.userAgent?.includes("Cloudflare-Workers")) return "cloudflare-workers";
    if (nav?.userAgent) return "browser";
  } catch {
    // A locked-down runtime can throw on globals — never let identifying ourselves break a request.
  }
  return "unknown";
}
