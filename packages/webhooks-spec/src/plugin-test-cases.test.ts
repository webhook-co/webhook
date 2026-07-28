import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// @ts-expect-error -- plain .mjs fixture data outside this package's tsconfig; shape asserted below.
import { FIXTURES } from "../../../plugin/webhook-co/testing/fixtures.mjs";
import { getAdapterForScheme } from "./index";

/**
 * The agent plugin ships 5 positive submission test cases, each claiming a specific diagnosis. This
 * REPLAYS them through the real engine so the claims stay true as the registry moves.
 *
 * It lives here rather than in `scripts/plugin-test-cases-guard.mjs` because that script runs in the
 * `lint` job, which does not build — importing the engine from there meant importing a gitignored
 * `dist/`, which passed locally off a stale build and crashed CI with ERR_MODULE_NOT_FOUND. Here the
 * import is `./index` in source, and the `test` job builds its dependencies first.
 *
 * The guard keeps the structural half (exactly 5 and 3, required fields, every fixtureId resolving,
 * and each refusal being present in SKILL.md). Between them the cases cannot rot silently.
 */

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const CASES = JSON.parse(
  readFileSync(`${REPO}plugin/webhook-co/testing/test-cases.json`, "utf8"),
) as {
  positive: {
    id: string;
    fixtureId: string;
    expected: { ok: boolean; reasonCode?: string; keyId?: string };
  }[];
};

interface Fixture {
  provider: string;
  body: string;
  headers: [string, string][];
  secrets: string[];
  nowUnix: number;
}
const fixtures = FIXTURES as Record<string, Fixture>;

describe("the plugin's submission test cases still produce what they claim", () => {
  it("there are cases to replay at all", () => {
    // Floor: an empty list would make every `it.each` below vacuous.
    expect(CASES.positive.length).toBeGreaterThan(0);
  });

  it.each(CASES.positive)("$id", async ({ fixtureId, expected }) => {
    const fixture = fixtures[fixtureId];
    expect(fixture, `no fixture named ${fixtureId}`).toBeDefined();

    const adapter = getAdapterForScheme(fixture.provider as never);
    expect(adapter, `no adapter for ${fixture.provider}`).toBeDefined();

    const result = await adapter!.verify({
      rawBody: new TextEncoder().encode(fixture.body),
      headers: fixture.headers,
      secrets: fixture.secrets,
      now: new Date(fixture.nowUnix * 1000),
    });

    expect(result.ok).toBe(expected.ok);
    if (expected.reasonCode !== undefined && !result.ok) {
      expect(result.reason.code).toBe(expected.reasonCode);
    }
    if (expected.keyId !== undefined && result.ok) {
      expect(result.keyId).toBe(expected.keyId);
    }
  });
});
