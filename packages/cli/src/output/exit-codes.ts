import { ExitCode } from "@stricli/core";
import { CAPABILITY_ERRORS, type CapabilityError } from "@webhook-co/contract";

// Stable, scriptable process exit codes — the CLI's PUBLISHED contract (locked by a test + ADR). Reserved
// generic codes are low; per-capability failures get distinct codes so CI/automation can branch on the
// specific failure. Treat these numbers as an API: never renumber without a deliberate, reviewed change.
//
//   0   SUCCESS            the command succeeded
//   1   UNEXPECTED         an unexpected/internal failure (uncaught error, library fault)
//   2   USAGE              bad invocation — unknown command, bad flag/arg (stricli parse/routing)
//   3   AUDIT_BREAK        `audit verify` ran OK but DETECTED a chain break (a meaningful non-zero)
//   64  NOT_IMPLEMENTED    the requested capability isn't built yet
//   10  UNAUTHORIZED       not logged in / credential rejected
//   11  FORBIDDEN          authenticated but not allowed
//   12  NOT_FOUND          the target resource doesn't exist
//   13  VALIDATION_ERROR   the request was malformed / failed server validation
//   14  RATE_LIMITED       throttled (after exhausting bounded retries)
//   15  ENDPOINT_PAUSED    the endpoint is paused
//   16  TARGET_UNREACHABLE a forward/replay target could not be reached
export const EXIT = {
  SUCCESS: 0,
  UNEXPECTED: 1,
  USAGE: 2,
  // `audit verify` succeeded as a call but DETECTED a chain break — a meaningful non-zero so
  // a cron/CI run alerts, distinct from a transport/usage failure. Low generic code (not a
  // per-capability error, since the request itself returned 200).
  AUDIT_BREAK: 3,
  NOT_IMPLEMENTED: 64,
} as const;

/** One distinct, non-zero code per capability failure (10+ to clear the reserved codes). */
export const CAPABILITY_EXIT: Record<CapabilityError, number> = {
  UNAUTHORIZED: 10,
  FORBIDDEN: 11,
  NOT_FOUND: 12,
  VALIDATION_ERROR: 13,
  RATE_LIMITED: 14,
  ENDPOINT_PAUSED: 15,
  TARGET_UNREACHABLE: 16,
};

export function exitCodeForCapabilityError(error: CapabilityError): number {
  return CAPABILITY_EXIT[error];
}

// stricli reports routing/parse/library failures via negative sentinel ExitCodes. Process
// exit codes are 0–255, so translate: parse/routing → USAGE(2), library/internal → 1,
// success → 0, positive command codes (incl. our CliError codes) pass through unchanged.
export function normalizeStricliExitCode(raw: number | string | null | undefined): number {
  if (raw === null || raw === undefined) return EXIT.SUCCESS;
  if (typeof raw === "string") return EXIT.UNEXPECTED;
  if (raw === ExitCode.Success) return EXIT.SUCCESS;
  if (raw === ExitCode.UnknownCommand || raw === ExitCode.InvalidArgument) return EXIT.USAGE;
  if (raw < 0) return EXIT.UNEXPECTED;
  return raw;
}

// Re-exported so the capability-error taxonomy is reachable from one place in the CLI.
export { CAPABILITY_ERRORS };
export type { CapabilityError };
