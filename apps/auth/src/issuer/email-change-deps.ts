// The auth-side of the web→auth email-change + login-methods RPCs. Only apps/auth (webhook_auth via
// HYPERDRIVE_AUTH) may touch the global identity realm; apps/web verifies the session and passes its OWN
// userId over the worker-to-worker binding. These wire the real DB helpers + RATELIMIT_KV + Resend to the
// pure `email-change-core` state machine; the WorkerEntrypoint (worker.ts, tsc-excluded) is a thin shell.

import type {
  CommitEmailChangeResult,
  LoginMethodsSnapshot,
  StartEmailChangeResult,
  UnlinkLoginMethodResult,
} from "@webhook-co/contract";
import {
  bumpPendingEmailChangeAttempts,
  commitEmailChange as commitEmailChangeDb,
  countLoginMethods,
  createClient,
  deleteAllUserSessions,
  deletePendingEmailChange,
  emailInUseByAnother,
  EmailTakenError,
  getAuthUserProfile,
  listLoginMethods,
  purgeVerificationsForEmails,
  readPendingEmailChange,
  unlinkLoginMethod,
  upsertPendingEmailChange,
} from "@webhook-co/db";
import { readSecretBinding } from "@webhook-co/shared";
import { resolveEmailMode, type EmailMode } from "@webhook-co/shared/email-transport";

import { sendEmailChangedNotice, sendEmailChangeOtp } from "../runtime/email-change-email";
import {
  commitEmailChange as runCommitEmailChange,
  startEmailChange as runStartEmailChange,
  type EmailChangeOps,
} from "./email-change-core";
import { generateOtp, hashOtp, otpMatches } from "./email-change-otp";
import { consumeRateLimit, type RateLimitKv } from "./rate-limit";

type Secret = Parameters<typeof readSecretBinding>[0];

/** The env slice the RPCs need: the identity Hyperdrive, the durable rate-limiter KV, the Resend key, and the
 *  server pepper the OTP is keyed with. */
export interface EmailChangeEnv {
  readonly HYPERDRIVE_AUTH: { readonly connectionString: string };
  readonly RATELIMIT_KV: RateLimitKv;
  /** Absent only under EMAIL_MODE=log (local dev), where the OTP mail is printed instead of sent. */
  readonly RESEND_API_KEY?: Secret;
  /** Local-dev only — see @webhook-co/shared/email-transport. */
  readonly EMAIL_MODE?: string;
  readonly CREDENTIAL_PEPPER: Secret;
}

/** ~15-minute windows (KV TTL floor is 60s). Send is generous (a real user may re-request); verify is the
 *  guess path. */
const SEND_RULE = { limit: 5, windowSeconds: 900 } as const;
const VERIFY_RULE = { limit: 10, windowSeconds: 900 } as const;
const OTP_TTL_SECONDS = 600; // 10 minutes
const MAX_ATTEMPTS = 5;

type RlDeps = { kv: RateLimitKv; nowSeconds: () => number };

/**
 * The SEND throttle FAILS OPEN — a KV blip must not block a legitimate re-request (the exposure is bounded by
 * the window + hashed key + write-protected KV). Exported so the fail-open direction is pinned by a test:
 * swapping it to fail-closed would degrade availability, but swapping VERIFY's fail-closed to fail-open would
 * reopen OTP guessing — so both catches are load-bearing and tested.
 */
export async function rateLimitSendAllowed(deps: RlDeps, userId: string): Promise<boolean> {
  try {
    return (await consumeRateLimit(deps, `email-change:send:${userId}`, SEND_RULE)).allowed;
  } catch {
    return true;
  }
}

/** The VERIFY (guess) throttle FAILS CLOSED — a KV fault must never become an open guessing window. */
export async function rateLimitVerifyAllowed(deps: RlDeps, userId: string): Promise<boolean> {
  try {
    return (await consumeRateLimit(deps, `email-change:verify:${userId}`, VERIFY_RULE)).allowed;
  } catch {
    return false;
  }
}

function makeOps(
  authClient: ReturnType<typeof createClient>,
  kv: RateLimitKv,
  pepper: string,
  apiKey: string,
  mode: EmailMode,
): EmailChangeOps {
  const nowSeconds = () => Math.floor(Date.now() / 1000);
  const senderDeps = { apiKey, mode };
  return {
    now: () => Date.now(),
    maxAttempts: MAX_ATTEMPTS,
    otpTtlSeconds: OTP_TTL_SECONDS,
    readProfile: async (userId) => {
      const p = await getAuthUserProfile(authClient, userId);
      return p ? { email: p.email } : null;
    },
    emailInUseByAnother: (email, exceptUserId) =>
      emailInUseByAnother(authClient, { email, exceptUserId }),
    rateLimitSend: (userId) => rateLimitSendAllowed({ kv, nowSeconds }, userId),
    generateOtp: () => generateOtp((n) => crypto.getRandomValues(new Uint8Array(n))),
    hashOtp: (userId, code) => hashOtp(pepper, userId, code),
    upsertPending: (input) => upsertPendingEmailChange(authClient, input),
    sendOtpEmail: (to, code) => sendEmailChangeOtp(senderDeps, { to, code }),
    readPending: (userId) => readPendingEmailChange(authClient, userId),
    rateLimitVerify: (userId) => rateLimitVerifyAllowed({ kv, nowSeconds }, userId),
    bumpAttempts: (userId) => bumpPendingEmailChangeAttempts(authClient, userId),
    otpMatches,
    commitEmail: async (userId, newEmail) => {
      await commitEmailChangeDb(authClient, { userId, newEmail });
    },
    isEmailTaken: (error) => error instanceof EmailTakenError,
    deleteAllSessions: async (userId) => {
      await deleteAllUserSessions(authClient, userId);
    },
    purgeVerifications: (emails) => purgeVerificationsForEmails(authClient, emails),
    deletePending: (userId) => deletePendingEmailChange(authClient, userId),
    sendChangedNotice: (oldEmail, newEmail) =>
      sendEmailChangedNotice(senderDeps, { to: oldEmail, newEmail }),
  };
}

async function withOps<T>(
  env: EmailChangeEnv,
  fn: (ops: EmailChangeOps) => Promise<T>,
): Promise<T> {
  const authClient = createClient(env.HYPERDRIVE_AUTH.connectionString, { max: 1 });
  try {
    // Under EMAIL_MODE=log there is no Resend key to resolve — the OTP is printed to the console instead.
    const mode = resolveEmailMode(env);
    const [pepper, apiKey] = await Promise.all([
      readSecretBinding(env.CREDENTIAL_PEPPER),
      mode === "log" ? Promise.resolve("") : readSecretBinding(env.RESEND_API_KEY!),
    ]);
    return await fn(makeOps(authClient, env.RATELIMIT_KV, pepper, apiKey, mode));
  } finally {
    await authClient.end();
  }
}

export function startEmailChangeRpc(
  env: EmailChangeEnv,
  input: { userId: string; newEmail: string },
): Promise<StartEmailChangeResult> {
  return withOps(env, (ops) => runStartEmailChange(ops, input));
}

export function commitEmailChangeRpc(
  env: EmailChangeEnv,
  input: { userId: string; code: string },
): Promise<CommitEmailChangeResult> {
  return withOps(env, (ops) => runCommitEmailChange(ops, input));
}

// ── Login methods ────────────────────────────────────────────────────────────────────────────────────────

/** The env slice login-methods needs — just the identity Hyperdrive (no email/KV/pepper). */
export interface LoginMethodsEnv {
  readonly HYPERDRIVE_AUTH: { readonly connectionString: string };
}

export async function listLoginMethodsRpc(
  env: LoginMethodsEnv,
  userId: string,
): Promise<LoginMethodsSnapshot> {
  const authClient = createClient(env.HYPERDRIVE_AUTH.connectionString, { max: 1 });
  try {
    const rows = await listLoginMethods(authClient, userId);
    return {
      methods: rows.map((r) => ({
        providerId: r.providerId,
        accountId: r.accountId,
        linkedAt: Math.floor(r.linkedAt.getTime() / 1000),
      })),
      // Magic-link (email) is always a sign-in path here — the issuer serves social + magic-link only.
      hasMagicLink: true,
    };
  } finally {
    await authClient.end();
  }
}

export async function unlinkLoginMethodRpc(
  env: LoginMethodsEnv,
  input: { userId: string; providerId: string; accountId: string },
): Promise<UnlinkLoginMethodResult> {
  const authClient = createClient(env.HYPERDRIVE_AUTH.connectionString, { max: 1 });
  try {
    // Last-method guard: never leave the user with ZERO sign-in paths. Magic-link always counts (email is a
    // login path), so removing a social account never strands them — but compute it defensively so a future
    // config that disables magic-link is still protected. (Better Auth's own allowUnlinkingAll:false is the
    // backstop for its unlink route; this is our direct-SQL path, so we enforce it ourselves.)
    const hasMagicLink = true;
    const count = await countLoginMethods(authClient, input.userId);
    const pathsAfter = count - 1 + (hasMagicLink ? 1 : 0);
    if (pathsAfter <= 0) {
      return {
        ok: false,
        error: "That's your only way to sign in — add another sign-in method first.",
        reason: "last_method",
      };
    }
    const deleted = await unlinkLoginMethod(authClient, input);
    if (!deleted)
      return { ok: false, error: "That login method is already gone.", reason: "not_found" };
    return { ok: true };
  } finally {
    await authClient.end();
  }
}
