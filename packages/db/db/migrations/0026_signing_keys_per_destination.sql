-- migrate:up

-- S3 Slice 2 (ADR-0084): re-point the outbound signing key from the inbound endpoint to the RECEIVING
-- destination. A Standard Webhooks signing secret is unique PER RECEIVER (the spec: "Signing keys should
-- be unique per endpoint" — endpoint = the receiver), which for remote replay is the replay_destination,
-- not the source endpoint that captured the event. signing_keys (migration 0003) was provisioned for
-- outbound signing but never used by any code (only an RLS-isolation test seeded it), so moving the owner
-- FK is safe. Multi-row-per-destination with status (active/retiring/revoked) is exactly what zero-downtime
-- rotation needs (two signatures, space-delimited, during overlap). The envelope columns + status + RLS +
-- the webhook_app grant are unchanged. replay_destinations already exposes unique (id, org_id) (0024) as
-- the composite-FK target, so org_id stays tamper-covered on the child.
-- The table was never read/written by any code (only an RLS-isolation test seeded it), so any pre-existing
-- rows are inert + reference the now-dropped endpoint_id. Clear them so `add destination_id NOT NULL`
-- succeeds on ANY deployment (ours is empty; a self-host's stray rows are dead).
delete from signing_keys;
alter table signing_keys drop constraint signing_keys_endpoint_id_org_id_fkey;
alter table signing_keys drop column endpoint_id;
alter table signing_keys add column destination_id uuid not null;
alter table signing_keys
  add constraint signing_keys_destination_id_org_id_fkey
  foreign key (destination_id, org_id) references replay_destinations (id, org_id) on delete cascade;
create index signing_keys_destination_idx on signing_keys (destination_id, org_id);

-- migrate:down
-- Destination-scoped rows are structurally incompatible with the endpoint-scoped shape (no endpoint_id
-- to backfill), so a rollback DROPS the signing secrets (re-mintable via rotateSigningSecret). Clearing
-- the table first is what keeps the `add endpoint_id NOT NULL` re-add executable post-deploy.
delete from signing_keys;
drop index if exists signing_keys_destination_idx;
alter table signing_keys drop constraint signing_keys_destination_id_org_id_fkey;
alter table signing_keys drop column destination_id;
alter table signing_keys add column endpoint_id uuid not null;
alter table signing_keys
  add constraint signing_keys_endpoint_id_org_id_fkey
  foreign key (endpoint_id, org_id) references endpoints (id, org_id) on delete cascade;
