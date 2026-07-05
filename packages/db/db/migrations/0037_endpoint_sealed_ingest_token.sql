-- migrate:up

-- Recoverable, envelope-encrypted copy of an endpoint's ingest token (S8-remainder, decision-0018 /
-- ADR-0075..0077). The ingest URL becomes ALWAYS-SHOWN: today endpoints store only the one-way peppered
-- HMAC (ingest_token_hash), so the wbhk.my/<token> URL is unrecoverable after the one-time create/rotate
-- reveal. These columns hold a SECOND representation of the SAME token — sealed under the engine-only AWS-KMS
-- envelope (the identical scheme as signing_keys / provider_secrets, ADR-0078): a per-token AES-256-GCM
-- ciphertext, the KEK-wrapped DEK + its ref, the nonce, the envelope version, and enc_context (audit-only).
-- ingest_key_id is the AAD keyId (a fresh random uuid per mint) — kept as its OWN column because the sealed
-- copy lives on the endpoints row itself (unlike provider_secrets, where the row id IS the keyId), so the
-- reveal path reconstructs the AAD {org_id, endpoints.id, ingest_key_id} from AUTHORITATIVE columns and
-- never from the enc_context jsonb. A DB/RLS-scoped read breach therefore yields ciphertext, not live URLs.
--
-- Nullable, no default: a metadata-only add (no table rewrite, no backfill, instant — the 0021 pattern).
-- Every EXISTING row reads NULL = "no recoverable copy" — its plaintext is gone (one-way hash), so it stays
-- unrecoverable until the owner ROTATES (which mints + seals a fresh token). NEVER force-rotate existing
-- endpoints to manufacture a copy: rotate is a hard cutover that 404s already-configured senders.
--
-- HOT PATH UNCHANGED. The webhook_authn ingest COLD lookup selects EXPLICIT columns
-- (id, org_id, ingest_token_hash, paused, deleted_at) and is a by-hash single-row fetch — it never reads
-- these columns and its heap-width cost is immaterial. GRANT HYGIENE (load-bearing): webhook_authn holds a
-- COLUMN-scoped SELECT grant (migration 0011) — new columns are NOT auto-granted to it, so the resolver role
-- literally CANNOT read the sealed ingest bytes (deny-by-default). We deliberately do NOT extend that grant.
-- The control plane (webhook_app) holds a TABLE-level grant (migration 0003), which auto-covers these columns
-- for the create/rotate writes and the RLS-org-scoped reveal read — exactly the roles that should see them.
alter table endpoints
  add column ingest_token_ciphertext bytea,
  add column ingest_token_wrapped_dek bytea,
  add column ingest_token_kek_ref text,
  add column ingest_token_enc_nonce bytea,
  add column ingest_token_enc_context jsonb,
  add column ingest_token_envelope_version smallint,
  add column ingest_key_id uuid;

-- migrate:down

-- Rolling back un-ships the recoverable copy: dropping the columns reverts endpoints to hash-only storage
-- (the always-shown reveal returns null everywhere, the code reverts in lockstep). No data operation — the
-- sealed copy is redundant with the still-present ingest_token_hash + the one-time create/rotate reveal.
alter table endpoints
  drop column ingest_token_ciphertext,
  drop column ingest_token_wrapped_dek,
  drop column ingest_token_kek_ref,
  drop column ingest_token_enc_nonce,
  drop column ingest_token_enc_context,
  drop column ingest_token_envelope_version,
  drop column ingest_key_id;
