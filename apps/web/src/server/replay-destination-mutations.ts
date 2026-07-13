import "server-only";
import { userActor } from "@webhook-co/shared";

import { withTenant } from "@webhook-co/db/client";
import {
  createReplayDestinationWithSigningSecret,
  enableReplayDestination,
  getReplayDestination,
  setDestinationOrdered as dbSetDestinationOrdered,
  softDeleteReplayDestination,
  type ReplayDestinationRecord,
} from "@webhook-co/db/replay-destinations";
import { rotateSigningSecret } from "@webhook-co/db/signing-keys";
import { canonicalizeAndValidateUrl, type SecretSealer } from "@webhook-co/shared";
import { importAuditKey } from "@webhook-co/shared/audit";
import { b64ToBytes } from "@webhook-co/shared/bytes";

import { getTenantDb } from "./db";
import { getAuditChainKey, getProviderSecretSealer } from "./env";

// The replay-destination create/rotate/enable/setOrdered/delete orchestration — the session counterpart of
// api's `createReplayDestinationHandlers` seam, one level up from Lane B's tx-atomic db fns. Each runs under
// withTenant(orgId) as webhook_app (RLS-scoped by the session orgId; any org member may manage). create +
// rotate MINT a signing secret, sealed by the engine's seal-only `PROVIDER_SECRET_SEALER` RPC — the KEK
// never enters the web worker; the plaintext `whsec_` is revealed to the caller ONCE (never SSR'd, logged,
// or persisted beyond the seal). The URL is canonicalized + structurally SSRF-checked HERE (the authoritative
// registration-time reject) before any db write; the engine's connect-time DoH/CIDR guard is the second,
// authoritative layer at delivery.

/** Raised when a create URL fails the structural SSRF/canonicalization check; `reason` maps to friendly copy. */
export class InvalidDestinationUrlError extends Error {
  constructor(readonly reason: string) {
    super(`invalid destination url: ${reason}`);
    this.name = "InvalidDestinationUrlError";
  }
}

/** Raised when a secret-minting op is attempted without the engine seal binding — fail closed, never store plaintext. */
export class SealerUnavailableError extends Error {
  constructor() {
    super("PROVIDER_SECRET_SEALER is not configured");
    this.name = "SealerUnavailableError";
  }
}

/** Fail-closed sealer guard: a create/rotate must never proceed (and store an unsigned/plaintext secret) without it. */
export function requireSealer(sealer: SecretSealer | undefined): SecretSealer {
  if (!sealer) throw new SealerUnavailableError();
  return sealer;
}

export interface CreatedDestination {
  /** The stored record (includes orgId; the loader/action strips it for the browser). */
  readonly record: ReplayDestinationRecord;
  /** The one-time `whsec_` plaintext — present only on a FRESH create (omitted on an idempotent re-add). */
  readonly signingSecret?: string;
}

export interface CreateDestinationInput {
  readonly orgId: string;
  readonly url: string;
  readonly label?: string | null;
  readonly actor: string;
}
export interface MutateDestinationInput {
  readonly orgId: string;
  readonly destinationId: string;
  readonly actor: string;
}
export interface SetOrderedInput extends MutateDestinationInput {
  readonly ordered: boolean;
}

/**
 * Injectable boundaries for the glue unit tests; the pure transforms (URL canonicalization, the sealer
 * guard, the audit-key import) are NOT injected so a test still exercises the real security logic. The
 * default binds live env + the sealer RPC + Lane B over the per-request tenant pool.
 */
export interface ReplayDestinationDeps {
  create(
    orgId: string,
    canonicalUrl: string,
    label: string | null,
    actor: string,
  ): Promise<CreatedDestination>;
  remove(orgId: string, id: string, actor: string): Promise<{ id: string; deletedAt: Date } | null>;
  enable(orgId: string, id: string, actor: string): Promise<ReplayDestinationRecord | null>;
  setOrdered(
    orgId: string,
    id: string,
    ordered: boolean,
    actor: string,
  ): Promise<ReplayDestinationRecord | null>;
  rotate(
    orgId: string,
    id: string,
    actor: string,
  ): Promise<{ keyId: string; secret: string } | null>;
}

async function defaultDeps(): Promise<{ deps: ReplayDestinationDeps; close: () => Promise<void> }> {
  // Resolve the audit key BEFORE opening the pool (a fail-closed getAuditChainKey must not strand an open
  // pool on its error path), exactly as endpoint-mutations does. The sealer is resolved eagerly too so a
  // missing binding fails closed at the first create/rotate rather than after a partial write.
  const auditKey = await importAuditKey(b64ToBytes(await getAuditChainKey()));
  const sealer = getProviderSecretSealer();
  const app = await getTenantDb();
  return {
    deps: {
      create: (orgId, canonicalUrl, label, actor) =>
        createReplayDestinationWithSigningSecret(
          app,
          { orgId, url: canonicalUrl, label, lastValidatedAt: new Date() },
          requireSealer(sealer),
          { auditKey, actor: userActor(actor) },
        ),
      remove: (orgId, id, actor) =>
        softDeleteReplayDestination(app, orgId, id, { auditKey, actor: userActor(actor) }),
      enable: (orgId, id, actor) =>
        enableReplayDestination(app, orgId, id, { auditKey, actor: userActor(actor) }),
      setOrdered: (orgId, id, ordered, actor) =>
        dbSetDestinationOrdered(app, orgId, id, ordered, { auditKey, actor: userActor(actor) }),
      rotate: async (orgId, id, actor) => {
        // Resolve the destination FIRST (mirrors the api handler): an unknown / cross-org / soft-deleted id
        // is NOT_FOUND (null) — never mint + reveal a fresh secret or write audit rows for a dead resource,
        // and never hit the signing_keys composite-FK error path. The resolve and the mint are two txs (same
        // as the api handler), so a soft-delete racing into the gap can still mint a secret for a just-removed
        // destination — benign: the secret is RLS-scoped + audited + useless (no live destination will ever
        // sign with it), never a cross-tenant leak. Closing the window fully would need a single-tx rotate in
        // the db layer, which we deliberately keep at parity with api rather than forking here.
        const live = await withTenant(app, orgId, (tx) => getReplayDestination(tx, id));
        if (!live) return null;
        return rotateSigningSecret(app, { orgId, destinationId: id }, requireSealer(sealer), {
          auditKey,
          actor: userActor(actor),
        });
      },
    },
    // Nothing to release. The REQUEST owns the tenant client now (see server/db.ts): it is shared by every
    // loader and action in the request and closed exactly once, after the response. Closing it here would pull
    // the connection out from under everything else still using it.
    //
    // The seam itself stays, and is not vestigial: its contract is "release whatever THIS deps provider
    // acquired", and an injected provider already returns a no-op for the same reason. This provider simply no
    // longer acquires a pool of its own.
    close: async () => {},
  };
}

async function run<T>(
  injected: ReplayDestinationDeps | undefined,
  fn: (deps: ReplayDestinationDeps) => Promise<T>,
): Promise<T> {
  const { deps, close } = injected
    ? { deps: injected, close: async () => {} }
    : await defaultDeps();
  try {
    return await fn(deps);
  } finally {
    await close();
  }
}

/**
 * Register a replay destination + mint & seal its first signing secret atomically (Lane B), then return the
 * one-time `whsec_`. The URL is canonicalized + SSRF-checked HERE (fail-closed BEFORE any db write); a bad
 * URL throws `InvalidDestinationUrlError` with the structural reason. The secret is returned ONCE.
 */
export async function createDestination(
  input: CreateDestinationInput,
  injected?: ReplayDestinationDeps,
): Promise<CreatedDestination> {
  const validated = canonicalizeAndValidateUrl(input.url);
  if (!validated.ok) throw new InvalidDestinationUrlError(validated.reason);
  return run(injected, (deps) =>
    deps.create(input.orgId, validated.url, input.label ?? null, input.actor),
  );
}

/** Soft-delete a destination (+ cancel its still-open deliveries, in-tx). Returns null → NOT_FOUND. */
export function removeDestination(
  input: MutateDestinationInput,
  injected?: ReplayDestinationDeps,
): Promise<{ id: string; deletedAt: Date } | null> {
  return run(injected, (deps) => deps.remove(input.orgId, input.destinationId, input.actor));
}

/** Re-enable an auto-disabled destination. Returns null → NOT_FOUND. */
export function enableDestination(
  input: MutateDestinationInput,
  injected?: ReplayDestinationDeps,
): Promise<ReplayDestinationRecord | null> {
  return run(injected, (deps) => deps.enable(input.orgId, input.destinationId, input.actor));
}

/** Toggle a destination's strict-FIFO (`ordered`) mode. Returns null → NOT_FOUND. */
export function setDestinationOrdered(
  input: SetOrderedInput,
  injected?: ReplayDestinationDeps,
): Promise<ReplayDestinationRecord | null> {
  return run(injected, (deps) =>
    deps.setOrdered(input.orgId, input.destinationId, input.ordered, input.actor),
  );
}

/**
 * Rotate a destination's signing secret (retire the active, mint a fresh one). Returns the one-time secret,
 * or null when the destination isn't live (unknown / cross-org / soft-deleted → the action maps to NOT_FOUND).
 */
export function rotateDestinationSecret(
  input: MutateDestinationInput,
  injected?: ReplayDestinationDeps,
): Promise<{ keyId: string; secret: string } | null> {
  return run(injected, (deps) => deps.rotate(input.orgId, input.destinationId, input.actor));
}
