// A4a — the RFC 8628 device authorization-code store, over KV.
//
// `@cloudflare/workers-oauth-provider` has no device grant, so Lane C owns the whole device flow. A device
// code is minted at /device_authorization BEFORE any user signs in, so it has no org/user yet — which means
// it can't live in a tenant-RLS table (the org-embedded-handle trick that backs the refresh store, ADR-0028,
// needs an org at creation), and a cross-org write role is exactly what that ADR avoided. So device codes
// live in KV: TTL-based expiry, no tenant context, fine for the high-churn poll. The trade-off is that KV
// is not transactional — single-use is enforced by delete-on-read (an approved/denied code is consumed when
// the first poll reads it), and the org/user are stamped only at approval. Two deliberate consequences:
//   - delete-on-read favours strict single-use over retry: if the caller's mint fails AFTER the poll
//     consumed the code, the approval is lost and the user re-approves — chosen over leaving the code live
//     (which would risk over-issuance). The minted keys are scoped + audited + revocable.
//   - it is not a hard guarantee under CONCURRENT reads: two polls that both read an `approved` record
//     before either delete lands would both return `approved`. The expected client is a single sequential
//     CLI poller (interval-gated), so this window doesn't arise in practice; A4b adds poll-rate limiting.
//
// Two KV entries per code: the record under `dc:<sha256(device_code)>` and an index `uc:<sha256(user_code)>`
// → the dc-key suffix, so the verify path (which has the user code) and the poll path (which has the device
// code) resolve the same record. Both codes are hashed into their keys so a KV listing never leaks a usable
// code; the device code is 256-bit CSPRNG and the user code is short + short-lived + rate-limited.

import { bytesToB64url, bytesToHex, utf8Encoder } from "@webhook-co/shared";

import type { ConsentProps } from "./token-core";

/** The minimal KV surface we use (avoids the Workers-global KVNamespace type under the DOM tsconfig). */
export interface DeviceKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts: { expirationTtl: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface DeviceStoreDeps {
  kv: DeviceKv;
  nowSeconds: () => number;
  /** CSPRNG bytes (injected so tests are deterministic). */
  randomBytes: (n: number) => Uint8Array;
}

/** The stored device-code record. org/user/grantScopes/deviceName are set only at approval. */
export interface DeviceCodeRecord {
  userCode: string;
  clientId: string;
  /** The scopes requested at /device_authorization. */
  scopes: string[];
  audience: string;
  status: "pending" | "approved" | "denied";
  /** Seconds between polls (RFC 8628 interval). */
  interval: number;
  /** Earliest unix-second the next poll is allowed — bumped each poll; enforces slow_down. */
  notBefore: number;
  createdAt: number;
  expiresAt: number;
  // set at approval:
  orgId?: string;
  userId?: string;
  /** The consented (intersected) scopes — what the key is minted with. */
  grantScopes?: string[];
  deviceName?: string;
}

export interface CreateDeviceCodeInput {
  clientId: string;
  scopes: string[];
  audience: string;
  ttlSeconds: number;
  interval: number;
}

export interface CreatedDeviceCode {
  deviceCode: string;
  userCode: string;
  interval: number;
  expiresIn: number;
}

// A user-code alphabet without visually ambiguous characters (no O/0, I/1/L) — all within [A-Z0-9] so it
// matches Lane E's canonical XXXX-XXXX form.
const USER_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const USER_CODE_LEN = 8;
// 256 isn't a multiple of the 31-char alphabet, so a plain `byte % len` would over-represent the first
// (256 mod 31 = 8) symbols. Reject any byte at/above the largest multiple of the alphabet length that fits
// in a byte (floor(256/31)*31 = 248), so every accepted byte maps to a symbol with equal probability.
const USER_CODE_REJECT_CEIL =
  Math.floor(256 / USER_CODE_ALPHABET.length) * USER_CODE_ALPHABET.length;
const DEVICE_CODE_BYTES = 32;
// A poll arriving early is bumped by the interval again (RFC 8628 lets the client raise its own interval by
// 5s on slow_down; the server-side floor mirrors that).
const SLOW_DOWN_PENALTY_SECONDS = 5;
// Cloudflare KV rejects an expirationTtl below 60s. Near a code's own expiry the remaining lifetime drops
// under that: a cosmetic notBefore re-write is skipped (it's throwaway), but a status change is clamped up
// to this floor so it still lands (see putRecord). The record's `expiresAt` is the authority for logical
// expiry regardless of the KV TTL.
const MIN_KV_TTL_SECONDS = 60;

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    utf8Encoder.encode(input) as Uint8Array<ArrayBuffer>,
  );
  return bytesToHex(new Uint8Array(digest));
}

const dcKey = (deviceCodeHash: string) => `dc:${deviceCodeHash}`;
const ucKey = (userCodeHash: string) => `uc:${userCodeHash}`;

/**
 * Canonicalize a user-entered code to the stored `XXXX-XXXX` form before hashing: uppercase, drop anything
 * outside [A-Z0-9], re-insert the dash (RFC 8628 §6.1 — tolerate case + separators). Mirrors Lane E's
 * client-side normalize so a code typed `abcd 2345` or `abcd-2345` resolves the same record.
 */
function normalizeUserCode(raw: string): string {
  const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return cleaned.length === USER_CODE_LEN ? `${cleaned.slice(0, 4)}-${cleaned.slice(4)}` : cleaned;
}

/**
 * A human-typeable XXXX-XXXX code drawn from the unambiguous alphabet, using rejection sampling so each
 * symbol is equally likely (no modulo bias). Bytes in the reject range are discarded and re-drawn; CSPRNG
 * bytes are pulled in batches (refilled on demand) to avoid per-byte draws.
 */
function generateUserCode(randomBytes: (n: number) => Uint8Array): string {
  let pool = randomBytes(USER_CODE_LEN);
  let next = 0;
  const drawByte = (): number => {
    // Reject the leftover values above the largest alphabet-aligned multiple, refilling the pool as needed.
    for (;;) {
      if (next >= pool.length) {
        pool = randomBytes(USER_CODE_LEN);
        next = 0;
      }
      const b = pool[next++]!;
      if (b < USER_CODE_REJECT_CEIL) return b;
    }
  };
  let s = "";
  for (let i = 0; i < USER_CODE_LEN; i++) {
    s += USER_CODE_ALPHABET[drawByte() % USER_CODE_ALPHABET.length];
  }
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/**
 * Persist a record under its dc-key with the remaining lifetime as the TTL — never extending the code's
 * logical life (`expiresAt` is the authority; `parseRecord` rejects a past-expiry record on read regardless
 * of the KV TTL).
 *
 * Default behaviour skips the write when the remaining lifetime is under the KV minimum — used for the
 * cosmetic notBefore/slow_down bump, which is genuinely throwaway in a code's final seconds.
 *
 * `clampTtl: true` instead floors the TTL at the KV minimum so the write always lands. This is for the
 * status-changing path (approve/deny): a decision made in the final 60s must persist, or the poller would
 * keep seeing `pending` until expiry and the approval would be silently lost. A slightly-longer-lived KV
 * row is harmless because `parseRecord` still gates on `expiresAt`.
 */
async function putRecord(
  deps: DeviceStoreDeps,
  deviceHash: string,
  record: DeviceCodeRecord,
  now: number,
  opts: { clampTtl?: boolean } = {},
): Promise<void> {
  const remaining = record.expiresAt - now;
  if (opts.clampTtl) {
    await deps.kv.put(dcKey(deviceHash), JSON.stringify(record), {
      expirationTtl: Math.max(MIN_KV_TTL_SECONDS, remaining),
    });
    return;
  }
  if (remaining < MIN_KV_TTL_SECONDS) return;
  await deps.kv.put(dcKey(deviceHash), JSON.stringify(record), { expirationTtl: remaining });
}

/** Mint a device code + user code and store a pending record (RFC 8628 §3.2). */
export async function createDeviceCode(
  deps: DeviceStoreDeps,
  input: CreateDeviceCodeInput,
): Promise<CreatedDeviceCode> {
  const now = deps.nowSeconds();
  const deviceCode = bytesToB64url(deps.randomBytes(DEVICE_CODE_BYTES));
  const userCode = generateUserCode(deps.randomBytes);
  const record: DeviceCodeRecord = {
    userCode,
    clientId: input.clientId,
    scopes: input.scopes,
    audience: input.audience,
    status: "pending",
    interval: input.interval,
    notBefore: 0,
    createdAt: now,
    expiresAt: now + input.ttlSeconds,
  };
  const deviceHash = await sha256Hex(deviceCode);
  const userHash = await sha256Hex(userCode);
  const ttl = { expirationTtl: input.ttlSeconds };
  await Promise.all([
    deps.kv.put(dcKey(deviceHash), JSON.stringify(record), ttl),
    deps.kv.put(ucKey(userHash), deviceHash, ttl),
  ]);
  return { deviceCode, userCode, interval: input.interval, expiresIn: input.ttlSeconds };
}

function parseRecord(raw: string | null, now: number): DeviceCodeRecord | null {
  if (raw === null) return null;
  let record: DeviceCodeRecord;
  try {
    record = JSON.parse(raw) as DeviceCodeRecord;
  } catch {
    return null;
  }
  // Defense beyond the KV TTL: never act on a record past its own expiry.
  if (typeof record.expiresAt !== "number" || now > record.expiresAt) return null;
  return record;
}

/** Resolve a record by the user-entered code (the verify path). Null = unknown/expired. */
export async function findByUserCode(
  deps: DeviceStoreDeps,
  userCode: string,
): Promise<DeviceCodeRecord | null> {
  const deviceHash = await deps.kv.get(ucKey(await sha256Hex(normalizeUserCode(userCode))));
  if (deviceHash === null) return null;
  return parseRecord(await deps.kv.get(dcKey(deviceHash)), deps.nowSeconds());
}

export type DeviceDecision = { decision: "approve"; props: ConsentProps } | { decision: "deny" };

export type SetDecisionResult = "ok" | "not_found" | "already_decided";

/** Record the user's approve/deny against the user code (the consent decision for a device grant). */
export async function setDeviceDecision(
  deps: DeviceStoreDeps,
  userCode: string,
  decision: DeviceDecision,
): Promise<SetDecisionResult> {
  const now = deps.nowSeconds();
  const userHash = await sha256Hex(normalizeUserCode(userCode));
  const deviceHash = await deps.kv.get(ucKey(userHash));
  if (deviceHash === null) return "not_found";
  const record = parseRecord(await deps.kv.get(dcKey(deviceHash)), now);
  if (!record) return "not_found";
  if (record.status !== "pending") return "already_decided";

  if (decision.decision === "approve") {
    record.status = "approved";
    record.orgId = decision.props.orgId;
    record.userId = decision.props.userId;
    record.grantScopes = decision.props.scopes;
    record.audience = decision.props.audience;
    if (decision.props.device) record.deviceName = decision.props.device.name;
  } else {
    record.status = "denied";
  }
  // A status change must always persist — even in the code's final 60s — so the poller observes the decision
  // rather than a stale `pending`. Clamp the KV TTL up to the minimum (harmless: `expiresAt` still gates).
  await putRecord(deps, deviceHash, record, now, { clampTtl: true });
  return "ok";
}

export type PollResult =
  | { kind: "pending" }
  | { kind: "slow_down" }
  | { kind: "denied" }
  | { kind: "invalid" }
  | { kind: "approved"; props: ConsentProps };

/** Delete both KV entries for a consumed/decided code (single-use). */
async function deleteRecord(
  deps: DeviceStoreDeps,
  deviceHash: string,
  record: DeviceCodeRecord,
): Promise<void> {
  await Promise.all([
    deps.kv.delete(dcKey(deviceHash)),
    deps.kv.delete(ucKey(await sha256Hex(record.userCode))),
  ]);
}

/**
 * Poll a device code (RFC 8628 §3.4/§3.5). The CLI calls this until it stops being `pending`/`slow_down`.
 * An approved/denied code is consumed (both keys deleted) on read — so it is single-use and a replay is
 * `invalid`. The caller mints from the returned props on `approved`.
 */
export async function pollDeviceCode(
  deps: DeviceStoreDeps,
  deviceCode: string,
): Promise<PollResult> {
  const now = deps.nowSeconds();
  const deviceHash = await sha256Hex(deviceCode);
  const record = parseRecord(await deps.kv.get(dcKey(deviceHash)), now);
  if (!record) return { kind: "invalid" };

  if (record.status === "approved") {
    await deleteRecord(deps, deviceHash, record);
    // Harden the approval invariant: a record marked approved must carry org/user/scopes (setDeviceDecision
    // sets them together). If any is missing (corruption / a future writer bug), fail closed as invalid
    // rather than minting a malformed key.
    if (!record.orgId || !record.userId || !record.grantScopes?.length) {
      return { kind: "invalid" };
    }
    const props: ConsentProps = {
      orgId: record.orgId,
      userId: record.userId,
      scopes: record.grantScopes,
      audience: record.audience,
      ...(record.deviceName ? { device: { name: record.deviceName } } : {}),
    };
    return { kind: "approved", props };
  }
  if (record.status === "denied") {
    await deleteRecord(deps, deviceHash, record);
    return { kind: "denied" };
  }

  // pending — enforce the poll interval (RFC 8628 slow_down).
  if (now < record.notBefore) {
    record.notBefore = now + record.interval + SLOW_DOWN_PENALTY_SECONDS;
    await putRecord(deps, deviceHash, record, now);
    return { kind: "slow_down" };
  }
  record.notBefore = now + record.interval;
  await putRecord(deps, deviceHash, record, now);
  return { kind: "pending" };
}
