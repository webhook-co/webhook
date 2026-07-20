import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import {
  FIRST_TOUCH_MAX_LEN,
  normalizeFirstTouch,
  stampSignupMilestone,
  type FirstTouch,
} from "../src/first-touch";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";
import { setupHookTimeoutMs } from "./pg-timing";

// First-touch acquisition attribution (PR4). At signup the auth service stamps signed_up_at + normalized,
// bounded, NEVER-PII utm_* into activation_org_milestones, first-touch-WINS. This suite pins the pure
// normalizer (bounded cardinality, control-char safety) and the writer's real-row upsert semantics
// (first-touch-wins, coexistence with a rollup-created row, signed_up_at set-once).

let pg: EphemeralPostgres;
let app: Sql;
let provider: Sql;

/** Seed an org with an explicit created_at (the canonical signup instant the writer derives signed_up_at
 *  from). Returns the orgId and the created_at Date so tests can assert signed_up_at against it. */
async function seedOrg(
  slug: string,
  createdAtMs: number,
): Promise<{ orgId: string; createdAt: Date }> {
  const orgId = randomUUID();
  const createdAt = new Date(createdAtMs);
  await withTenant(app, orgId, async (tx) => {
    await tx`insert into orgs (id, slug, name, created_at) values (${orgId}, ${slug}, ${slug}, ${createdAt.toISOString()})`;
  });
  return { orgId, createdAt };
}

async function milestoneOf(orgId: string): Promise<{
  signed_up_at: Date;
  first_touch_source: string | null;
  first_touch_medium: string | null;
  first_touch_campaign: string | null;
} | null> {
  return withTenant(app, orgId, async (tx) => {
    const [row] = await tx<
      {
        signed_up_at: Date;
        first_touch_source: string | null;
        first_touch_medium: string | null;
        first_touch_campaign: string | null;
      }[]
    >`select signed_up_at, first_touch_source, first_touch_medium, first_touch_campaign
      from activation_org_milestones where org_id = ${orgId}`;
    return row ?? null;
  });
}

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  provider = createClient(pg.providerUrl);
}, setupHookTimeoutMs());

afterAll(async () => {
  await app?.end();
  await provider?.end();
  await pg?.stop();
});

describe("normalizeFirstTouch", () => {
  it("trims, lowercases, and buckets the three utm dimensions", () => {
    expect(
      normalizeFirstTouch({ source: " Google ", medium: "CPC", campaign: "Launch-Week" }),
    ).toEqual({ source: "google", medium: "cpc", campaign: "launch-week" });
  });

  it("maps missing / empty / whitespace-only values to null", () => {
    expect(normalizeFirstTouch({})).toEqual({ source: null, medium: null, campaign: null });
    expect(normalizeFirstTouch({ source: "", medium: "   ", campaign: undefined })).toEqual({
      source: null,
      medium: null,
      campaign: null,
    });
    expect(normalizeFirstTouch({ source: null })).toEqual({
      source: null,
      medium: null,
      campaign: null,
    });
  });

  it("DROPS an over-length value to null (never truncates a misleading prefix)", () => {
    const long = "x".repeat(FIRST_TOUCH_MAX_LEN + 1);
    const ok = "y".repeat(FIRST_TOUCH_MAX_LEN);
    expect(normalizeFirstTouch({ source: long, medium: ok })).toEqual({
      source: null,
      medium: ok,
      campaign: null,
    });
  });

  it("DROPS a value containing whitespace or control characters to null (log/label safety)", () => {
    // Build the control char programmatically so no literal control byte lives in this source file.
    const withTab = "na" + String.fromCharCode(9) + "b"; // an embedded TAB
    expect(normalizeFirstTouch({ source: "goo gle", medium: withTab, campaign: "ok" })).toEqual({
      source: null,
      medium: null,
      campaign: "ok",
    });
  });

  it("DROPS unicode letters and all-punctuation values (only clean ascii slugs are kept)", () => {
    // The allowlist is ascii-only, so accented/full-width letters are dropped rather than mangled…
    expect(normalizeFirstTouch({ source: "café", medium: "ｆｕｌｌwidth" })).toEqual({
      source: null,
      medium: null,
      campaign: null,
    });
    // …and an all-punctuation value is noise, not a channel — dropped even though the chars are "safe".
    expect(normalizeFirstTouch({ source: ".", medium: "___", campaign: "--" })).toEqual({
      source: null,
      medium: null,
      campaign: null,
    });
    // A digit-only value is legitimate (e.g. a numeric campaign id) and is kept.
    expect(normalizeFirstTouch({ campaign: "2026" }).campaign).toBe("2026");
  });
});

describe("stampSignupMilestone", () => {
  it("creates the milestone row, deriving signed_up_at from orgs.created_at + first-touch", async () => {
    const { orgId, createdAt } = await seedOrg("ft-a", Date.UTC(2026, 6, 1, 12));
    await stampSignupMilestone(
      app,
      orgId,
      normalizeFirstTouch({ source: "twitter", medium: "social", campaign: "beta" }),
    );
    const m = await milestoneOf(orgId);
    expect(m?.signed_up_at.toISOString()).toBe(createdAt.toISOString());
    expect(m).toMatchObject({
      first_touch_source: "twitter",
      first_touch_medium: "social",
      first_touch_campaign: "beta",
    });
  });

  it("is first-touch-WINS: a second stamp never overwrites an existing touch", async () => {
    const { orgId, createdAt } = await seedOrg("ft-wins", Date.UTC(2026, 6, 1, 9));
    await stampSignupMilestone(app, orgId, { source: "google", medium: "cpc", campaign: "launch" });
    // A later touch (should be ignored — first-touch wins).
    await stampSignupMilestone(app, orgId, {
      source: "bing",
      medium: "organic",
      campaign: "later",
    });
    const m = await milestoneOf(orgId);
    expect(m?.signed_up_at.toISOString()).toBe(createdAt.toISOString());
    expect(m).toMatchObject({
      first_touch_source: "google",
      first_touch_medium: "cpc",
      first_touch_campaign: "launch",
    });
  });

  it("back-fills first-touch onto a row a rollup created first (null touch), keeping its signed_up_at", async () => {
    const { orgId } = await seedOrg("ft-rollup-first", Date.UTC(2026, 5, 20, 8)); // created_at Jun 20
    // Simulate the rollup having created the milestone row first, with a signed_up_at DIFFERENT from
    // orgs.created_at, so this test independently pins that the stamp's on-conflict never rewrites
    // signed_up_at (a `signed_up_at = excluded.signed_up_at` mutation would push it to created_at → caught).
    const rollupSignup = new Date(Date.UTC(2026, 5, 18, 8)); // Jun 18 — deliberately != created_at
    await withTenant(app, orgId, async (tx) => {
      await tx`insert into activation_org_milestones (org_id, signed_up_at) values (${orgId}, ${rollupSignup.toISOString()})`;
    });
    // The signup hook stamps later — its first-touch fills the nulls; signed_up_at is NOT overwritten.
    await stampSignupMilestone(app, orgId, {
      source: "referral",
      medium: "partner",
      campaign: null,
    });
    const m = await milestoneOf(orgId);
    expect(m?.signed_up_at.toISOString()).toBe(rollupSignup.toISOString());
    expect(m).toMatchObject({
      first_touch_source: "referral",
      first_touch_medium: "partner",
      first_touch_campaign: null,
    });
  });

  it("writes an all-null touch without error (e.g. an OAuth signup with no recoverable utm)", async () => {
    const { orgId, createdAt } = await seedOrg("ft-null", Date.UTC(2026, 6, 3, 12));
    const firstTouch: FirstTouch = { source: null, medium: null, campaign: null };
    await stampSignupMilestone(app, orgId, firstTouch);
    const m = await milestoneOf(orgId);
    expect(m?.signed_up_at.toISOString()).toBe(createdAt.toISOString());
    expect(m).toMatchObject({
      first_touch_source: null,
      first_touch_medium: null,
      first_touch_campaign: null,
    });
  });

  it("is written under RLS as the org's own tenant (webhook_app) — the insert policy is satisfied", async () => {
    // stampSignupMilestone uses withTenant(app, orgId, …); a plain app insert WITHOUT the tenant GUC is
    // refused by the with-check policy, proving the writer relies on the RLS context (not a bypass).
    const { orgId } = await seedOrg("ft-rls", Date.UTC(2026, 6, 4, 12));
    await expect(
      app`insert into activation_org_milestones (org_id, signed_up_at) values (${orgId}, now())`,
    ).rejects.toThrow(/row-level security|permission denied/i);
    // Via the writer it succeeds.
    await stampSignupMilestone(app, orgId, { source: "cli", medium: null, campaign: null });
    expect((await milestoneOf(orgId))?.first_touch_source).toBe("cli");
  });
});
