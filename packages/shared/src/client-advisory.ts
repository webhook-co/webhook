// CLIENT VERSION ADVISORIES — the server-driven "your SDK is out of date" mechanism.
//
// A library must NOT poll a package registry on the user's behalf: an unsolicited network call to npm/PyPI
// from inside someone's Lambda, Worker, or air-gapped box is a real problem, and writing to stderr from a
// library is worse. So the direction is INVERTED: the client identifies itself in its User-Agent, and the
// API answers with an advisory header ON A RESPONSE THE CALLER ALREADY ASKED FOR. Zero extra requests, zero
// registry polling, nothing to opt out of network-wise, and it works offline (you simply hear nothing).
//
// It also buys us something we have never had: the server can SEE which client versions are live, which is
// what makes a safe deprecation possible at all.
//
// The header carries ONLY version facts. It rides on every response, so it must never leak anything about
// the caller — no ids, no keys, no counts.

/** The advisory header. Lowercase: Workers normalises, but nothing here should depend on that. */
export const ADVISORY_HEADER = "x-webhook-advisory";

/** RFC 8594 / RFC 9745 style. Only set for versions below the supported floor — never for merely stale. */
export const DEPRECATION_HEADER = "deprecation";

/** The clients we ship. An id we don't know is never advised — see parseClientUserAgent. */
export const CLIENT_IDS = [
  "webhook-co-js",
  "webhook-co-python",
  "webhook-co-go",
  "wbhk-cli",
] as const;
export type ClientId = (typeof CLIENT_IDS)[number];

/**
 * The newest published version of each client.
 *
 * ⚠️ This is a DERIVED fact — the truth lives in npm / PyPI / the Go proxy. It is committed here because the
 * API needs it at request time, and a CI job (`client-versions-current`) fails if it falls behind what the
 * registries actually serve. Do not hand-edit it and hope: bump it as part of the release, and let the guard
 * catch you if you forget. (A derived value whose guard is not wired to its source is exactly how the Python
 * SDK's models rotted 12 schemas behind while CI stayed green.)
 */
export const CLIENT_LATEST: Record<ClientId, string> = {
  "webhook-co-js": "0.2.1",
  "webhook-co-python": "0.2.1",
  "webhook-co-go": "0.3.0",
  "wbhk-cli": "0.2.0",
};

/**
 * The oldest version we still support. BELOW this we send `Deprecation: true` as well — a louder signal
 * than "an update exists", reserved for versions that are actually broken or unsafe (e.g. a Go SDK before
 * the drift guard, which silently dropped `dedupConfig` and `sourceVerificationState` on the floor).
 *
 * Keep this HONEST: deprecating a version that still works fine trains people to ignore the header.
 */
export const CLIENT_MIN_SUPPORTED: Record<ClientId, string> = {
  // 0.2.0 was the first release with the full route surface; anything older cannot reach reveal/triggers.
  "webhook-co-js": "0.2.0",
  "webhook-co-python": "0.2.0",
  // Go < 0.3.0 silently DROPS dedupConfig + sourceVerificationState (they were missing from the models):
  // a user on 0.2.0 reads an endpoint and cannot see its dedup config at all. That is broken, not stale.
  "webhook-co-go": "0.3.0",
  "wbhk-cli": "0.1.0",
};

const CLIENT_ID_SET = new Set<string>(CLIENT_IDS);
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export interface ClientVersion {
  readonly id: ClientId;
  readonly version: string;
}

export interface Advisory {
  /** The `x-webhook-advisory` value: version facts only, nothing about the caller. */
  readonly headerValue: string;
  /** True only below CLIENT_MIN_SUPPORTED — a broken/unsafe version, not merely an old one. */
  readonly deprecated: boolean;
}

/**
 * Pull our own client + version out of a User-Agent. Returns null for ANYTHING we don't recognise — curl, a
 * browser, a hand-rolled client, or an id we don't ship. That null is what keeps the advisory header off
 * every third-party request: we only ever advise software we published.
 */
export function parseClientUserAgent(ua: string | null | undefined): ClientVersion | null {
  if (!ua) return null;
  const token = ua.trim().split(/\s+/)[0] ?? "";
  const slash = token.indexOf("/");
  if (slash <= 0) return null;
  const id = token.slice(0, slash);
  const version = token.slice(slash + 1);
  if (!CLIENT_ID_SET.has(id)) return null;
  if (!SEMVER.test(version)) return null; // half-parsing a version is worse than not parsing it
  return { id: id as ClientId, version };
}

/** -1 if a < b, 0 if equal, 1 if a > b. Numeric per-part; a prerelease sorts BELOW its release. */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = SEMVER.exec(a);
  const pb = SEMVER.exec(b);
  if (!pa || !pb) return 0; // unparseable → refuse to order (callers treat 0 as "say nothing")
  for (let i = 1; i <= 3; i++) {
    const na = Number(pa[i]);
    const nb = Number(pb[i]);
    if (na !== nb) return na < nb ? -1 : 1;
  }
  const prea = pa[4];
  const preb = pb[4];
  if (prea === preb) return 0;
  if (prea === undefined) return 1; // 0.3.0 > 0.3.0-rc.1
  if (preb === undefined) return -1;
  return prea < preb ? -1 : 1;
}

/**
 * The advisory for a client, or null to say NOTHING — which is the common case and must stay cheap.
 *
 * Null when: the client isn't ours, it's on the latest, or it is AHEAD of what we know (a prerelease, or we
 * forgot to bump CLIENT_LATEST). Never tell someone on a newer build that they're out of date.
 */
export function buildAdvisory(client: ClientVersion | null): Advisory | null {
  if (!client) return null;
  const latest = CLIENT_LATEST[client.id];
  const floor = CLIENT_MIN_SUPPORTED[client.id];
  if (compareSemver(client.version, latest) >= 0) return null; // current, or ahead of us

  const deprecated = compareSemver(client.version, floor) < 0;
  const kind = deprecated ? "deprecated" : "update-available";
  return {
    deprecated,
    headerValue: `${kind}; current=${client.version}; latest=${latest}`,
  };
}
