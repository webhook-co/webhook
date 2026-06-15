import { ExitCode } from "@stricli/core";
import { CAPABILITY_ERRORS, type CapabilityError } from "@webhook-co/contract";

// Stable, scriptable process exit codes. Reserved generic codes are low; per-capability
// failures get distinct codes so CI/automation can branch on the specific failure.
export const EXIT = {
  SUCCESS: 0,
  UNEXPECTED: 1,
  USAGE: 2,
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
