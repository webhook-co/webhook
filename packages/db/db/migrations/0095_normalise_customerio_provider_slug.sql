-- migrate:up

-- Normalise the duplicate Customer.io provider slug: `customerio` -> `customer_io`.
--
-- THE DUPLICATE. The registry carried TWO slugs for one real provider, with byte-identical schemes —
-- same `x-cio-signature` header, same hex encoding, same `x-cio-timestamp` header, the same
-- `v0:{ts}:{body}` signed message, and the same default tolerance. `customer_io` matches the
-- convention every other dotted-domain brand follows (cal_com, checkout_com, incident_io, merge_dev),
-- so it is the one that survives; `customerio` was an accidental second entry.
--
-- THIS MIGRATION IS HYGIENE, NOT A RESCUE. `provider_secrets.provider` and `events.provider` are both
-- plain `text` with no enum and no CHECK, so the database keeps holding `customerio` after the slug
-- leaves the registry. The code no longer depends on this migration having run: `canonicalProvider`
-- (packages/webhooks-spec) resolves the retired slug to `customer_io` on the way in, so verification
-- keeps working and the reads keep parsing either way. What the rewrite buys is that the stored data
-- stops disagreeing with the vocabulary, which is what makes the provider FILTER on the events list
-- return historical rows.

-- `events` is the largest table in the schema and its only index on `provider` leads with
-- `endpoint_id` (`events_provider_idx (endpoint_id, provider, received_at desc)`), so a bare
-- `where provider = 'customerio'` would sequentially scan all of it. The affected endpoints are
-- knowable up front, so collect them first and drive the rewrite off the index — and skip the events
-- statement entirely when there are none, which is the expected case. Guarding in a DO block rather
-- than an `in (subquery)` makes "we did not touch events" a certainty instead of a planner choice.
--
-- The endpoint set is EXHAUSTIVE, not a heuristic:
--   * the engine names an event's provider from the endpoint's REGISTERED secret (verify.ts drives
--     selection from the registered providers, not from header detection), so an event can only read
--     `customerio` if a `customerio` secret was registered on its endpoint;
--   * revoking a provider secret is a soft delete (`status -> 'revoked'`) and nothing anywhere issues
--     a `delete from provider_secrets`, so that row is still present to be found;
--   * `events` and `provider_secrets` both cascade from `endpoints`/`orgs`, so a deleted endpoint took
--     its events with it — there is no orphan event whose secret row has gone.
--
-- Both statements are idempotent: after the first pass nothing matches, so this is safe to re-run.
do $$
declare
  affected uuid[];
begin
  select array_agg(distinct endpoint_id) into affected
  from provider_secrets where provider = 'customerio';

  -- NULL when no endpoint ever registered the duplicate slug -> `events` is never read or written.
  if affected is not null then
    update events set provider = 'customer_io'
    where provider = 'customerio' and endpoint_id = any (affected);
  end if;

  -- Last, so the lookup above still had the evidence it needed.
  update provider_secrets set provider = 'customer_io' where provider = 'customerio';
end $$;

-- migrate:down

-- Deliberately NOT reversible. Down-migrating would have to guess which `customer_io` rows had been
-- `customerio` before, and there is no record of that — the two slugs are indistinguishable once
-- normalised. Restoring the wrong ones would break the provider filter for real endpoints, which is
-- worse than leaving them normalised. The slug that remains is valid in the old registry as well as
-- the new one, so rolling back the CODE alone is already safe with this data in place.
select 1;
