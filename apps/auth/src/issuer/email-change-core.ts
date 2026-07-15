import type { CommitEmailChangeResult, StartEmailChangeResult } from "@webhook-co/contract";

// The pure state machine of the email-change ceremony — all I/O is injected (`EmailChangeOps`), so every
// branch is unit-testable with no DB/KV/Resend. The deps wrapper (`email-change-deps.ts`) binds the real
// webhook_auth pool + RATELIMIT_KV + Resend to these ops; the WorkerEntrypoint (`worker.ts`) is a thin shell.
//
// SECURITY: the OTP goes to the user's CURRENT email (step-up — proves control of the address on record); the
// code is single-use, short-TTL, HMAC-peppered at rest, and verify FAILS CLOSED on a rate-limit fault so a KV
// outage can't become an open guessing window.

/** A basic well-formed-email check — one `@`, a dot in the domain, no spaces. The DB (citext unique) + the
 *  provider are the real authorities; this is early UX validation. */
export function isPlausibleEmail(email: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
}

export interface EmailChangeOps {
  // shared
  readonly now: () => number; // ms since epoch
  readonly maxAttempts: number; // verify lockout threshold
  readonly otpTtlSeconds: number;

  // start
  readProfile(userId: string): Promise<{ email: string } | null>;
  emailInUseByAnother(email: string, exceptUserId: string): Promise<boolean>;
  /** false = throttled. Fails OPEN internally (send availability > strict throttle). */
  rateLimitSend(userId: string): Promise<boolean>;
  generateOtp(): string;
  hashOtp(userId: string, code: string): Promise<Uint8Array>;
  upsertPending(input: {
    userId: string;
    newEmail: string;
    codeHash: Uint8Array;
    expiresAt: Date;
  }): Promise<void>;
  sendOtpEmail(to: string, code: string): Promise<void>;

  // commit
  readPending(
    userId: string,
  ): Promise<{ newEmail: string; codeHash: Uint8Array; expiresAt: Date; attempts: number } | null>;
  /** false = throttled → treated as locked (FAIL CLOSED). */
  rateLimitVerify(userId: string): Promise<boolean>;
  bumpAttempts(userId: string): Promise<number>;
  otpMatches(a: Uint8Array, b: Uint8Array): boolean;
  /** Throws when the address was taken between start and commit (citext unique backstop). */
  commitEmail(userId: string, newEmail: string): Promise<void>;
  isEmailTaken(error: unknown): boolean;
  deleteAllSessions(userId: string): Promise<void>;
  purgeVerifications(emails: string[]): Promise<void>;
  deletePending(userId: string): Promise<void>;
  sendChangedNotice(oldEmail: string, newEmail: string): Promise<void>;
}

/** Step 1: validate the new address, mint + send a 6-digit OTP to the CURRENT email. */
export async function startEmailChange(
  ops: EmailChangeOps,
  input: { userId: string; newEmail: string },
): Promise<StartEmailChangeResult> {
  const newEmail = input.newEmail.trim().toLowerCase();
  if (!isPlausibleEmail(newEmail)) {
    return { ok: false, error: "Enter a valid email address.", reason: "invalid" };
  }

  const profile = await ops.readProfile(input.userId);
  if (!profile) return { ok: false, error: "Your account couldn't be found.", reason: "invalid" };
  if (profile.email.toLowerCase() === newEmail) {
    return { ok: false, error: "That's already your email.", reason: "same" };
  }
  if (await ops.emailInUseByAnother(newEmail, input.userId)) {
    // Same message whether taken or not would be more privacy-preserving, but an authenticated user changing
    // their OWN email needs actionable feedback; the address space isn't enumerable here (rate-limited + authed).
    return { ok: false, error: "That email is already in use.", reason: "taken" };
  }
  if (!(await ops.rateLimitSend(input.userId))) {
    return {
      ok: false,
      error: "Too many requests — try again in a few minutes.",
      reason: "rate_limited",
    };
  }

  const code = ops.generateOtp();
  const codeHash = await ops.hashOtp(input.userId, code);
  const expiresAt = new Date(ops.now() + ops.otpTtlSeconds * 1000);
  await ops.upsertPending({ userId: input.userId, newEmail, codeHash, expiresAt });
  // Send AFTER storing — a send failure leaves a pending row the user can retry against, never a code with no
  // record. The OTP goes to the CURRENT address (step-up), which readProfile gave us.
  await ops.sendOtpEmail(profile.email, code);
  return { ok: true };
}

/** Step 2: verify the OTP, then commit the email + revoke sessions + purge verification + notify the old addr. */
export async function commitEmailChange(
  ops: EmailChangeOps,
  input: { userId: string; code: string },
): Promise<CommitEmailChangeResult> {
  const pending = await ops.readPending(input.userId);
  if (!pending) {
    return { ok: false, error: "Start an email change first.", reason: "no_pending" };
  }
  if (pending.expiresAt.getTime() <= ops.now()) {
    await ops.deletePending(input.userId);
    return { ok: false, error: "That code expired. Start again.", reason: "expired" };
  }
  if (pending.attempts >= ops.maxAttempts) {
    return { ok: false, error: "Too many attempts. Start again.", reason: "locked" };
  }
  // FAIL CLOSED: a rate-limit/KV fault on the guess path is treated as locked, never an open guessing window.
  if (!(await ops.rateLimitVerify(input.userId))) {
    return { ok: false, error: "Too many attempts. Try again later.", reason: "locked" };
  }

  const presented = await ops.hashOtp(input.userId, input.code.trim());
  if (!ops.otpMatches(presented, pending.codeHash)) {
    const attempts = await ops.bumpAttempts(input.userId);
    if (attempts >= ops.maxAttempts) {
      return { ok: false, error: "Too many attempts. Start again.", reason: "locked" };
    }
    return { ok: false, error: "That code isn't right.", reason: "invalid_code" };
  }

  const profile = await ops.readProfile(input.userId);
  if (!profile)
    return { ok: false, error: "Your account couldn't be found.", reason: "no_pending" };
  const oldEmail = profile.email;

  try {
    await ops.commitEmail(input.userId, pending.newEmail);
  } catch (error) {
    if (ops.isEmailTaken(error)) {
      await ops.deletePending(input.userId); // dead pending — the address was taken meanwhile
      return { ok: false, error: "That email is now in use. Start again.", reason: "taken" };
    }
    throw error;
  }

  // Post-commit cleanup — all best-effort-ordered but each matters: revoke every IdP session (no re-mint/
  // hand-off after this), kill in-flight magic links to BOTH addresses, drop the pending row, notify the OLD
  // address so a hijack is detectable.
  await ops.deleteAllSessions(input.userId);
  await ops.purgeVerifications([oldEmail, pending.newEmail]);
  await ops.deletePending(input.userId);
  await ops.sendChangedNotice(oldEmail, pending.newEmail);

  return { ok: true, oldEmail, newEmail: pending.newEmail };
}
