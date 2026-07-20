// First-touch acquisition attribution (marketing measurement layer, PR4). At signup the auth service stamps
// a normalized, bounded, NEVER-PII first-touch (utm_source / utm_medium / utm_campaign) into
// activation_org_milestones, first-touch-WINS. The utm strings are cookieless URL params carried through the
// signup flow; this module normalizes them (bounded cardinality + log/label safety) and writes them under
// the org's own webhook_app RLS context. There is no PII here — utm_* are campaign slugs, never a person.

import { withTenant, type Sql } from "./client";

/** Max length of a normalized first-touch dimension. utm_* are short acquisition-channel slugs; a value
 *  longer than this is dropped (not truncated) to keep the metric's cardinality bounded and its labels
 *  safe — a truncated prefix would be a misleading bucket. */
export const FIRST_TOUCH_MAX_LEN = 64;

/** A normalized first-touch: each dimension is a clean lowercase slug or null (never PII). */
export interface FirstTouch {
  readonly source: string | null;
  readonly medium: string | null;
  readonly campaign: string | null;
}

/** Raw utm values as they arrive from the signup URL (may be missing, empty, or hostile). */
export interface RawFirstTouch {
  readonly source?: string | null;
  readonly medium?: string | null;
  readonly campaign?: string | null;
}

// Allowlist for a stored dimension: lowercase alphanumerics plus `.`, `_`, `-` — the character set of a real
// utm slug. An ALLOWLIST (not a denylist) is the safe default: it rejects whitespace, control characters, and
// every log/label/injection-hostile byte by construction, so only clean, bounded buckets are ever stored.
const SAFE_SLUG = /^[a-z0-9._-]+$/;

/** Normalize one utm dimension: trim → lowercase, then drop (→ null) anything empty, over-length, or holding
 *  a character outside the safe slug set. Dropping rather than truncating/escaping keeps every stored value a
 *  clean, bounded, log-safe bucket — a value that isn't one is noise, not signal. */
function normalizeOne(v: string | null | undefined): string | null {
  if (v == null) return null;
  const slug = v.trim().toLowerCase();
  if (slug === "") return null;
  if (slug.length > FIRST_TOUCH_MAX_LEN) return null;
  if (!SAFE_SLUG.test(slug)) return null;
  // Require at least one alphanumeric — an all-punctuation value (".", "___", "--") is noise, not a channel.
  if (!/[a-z0-9]/.test(slug)) return null;
  return slug;
}

/** Normalize a raw utm triple into a bounded, PII-free FirstTouch. Pure. */
export function normalizeFirstTouch(raw: RawFirstTouch): FirstTouch {
  return {
    source: normalizeOne(raw.source),
    medium: normalizeOne(raw.medium),
    campaign: normalizeOne(raw.campaign),
  };
}

/**
 * Stamp the signup milestone for `orgId`: set signed_up_at and the first-touch dimensions, FIRST-TOUCH-WINS.
 * Runs under the org's own webhook_app RLS context (withTenant), so the insert satisfies the milestone table's
 * `with check (org_id = current_org_id())` policy — this is a tenant writing its OWN row, not a bypass.
 *
 * signed_up_at is derived from orgs.created_at (the canonical signup instant) — the SAME source
 * rollup_activation_milestones uses — so the hook and the rollup can never disagree on it regardless of which
 * writes first (webhook_app can read its own org's created_at, exactly as the rollup does). It is set on the
 * first insert and never overwritten. Each first_touch_* is `coalesce(existing, excluded)`, so an
 * already-recorded touch is never clobbered and a row the rollup created first (null touch) is back-filled.
 * If the org row is somehow absent, the `select … from orgs` yields no row and nothing is written.
 */
export async function stampSignupMilestone(
  app: Sql,
  orgId: string,
  firstTouch: FirstTouch,
): Promise<void> {
  await withTenant(app, orgId, async (tx) => {
    await tx`
      insert into activation_org_milestones
        (org_id, signed_up_at, first_touch_source, first_touch_medium, first_touch_campaign, updated_at)
      select o.id, o.created_at, ${firstTouch.source}, ${firstTouch.medium}, ${firstTouch.campaign}, now()
        from orgs o
       where o.id = ${orgId}
      on conflict (org_id) do update set
        first_touch_source   = coalesce(activation_org_milestones.first_touch_source,   excluded.first_touch_source),
        first_touch_medium   = coalesce(activation_org_milestones.first_touch_medium,   excluded.first_touch_medium),
        first_touch_campaign = coalesce(activation_org_milestones.first_touch_campaign, excluded.first_touch_campaign),
        updated_at = now()`;
  });
}
