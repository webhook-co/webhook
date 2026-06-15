import type { CapabilityError } from "@webhook-co/contract";

// Map the closed capability-error taxonomy to an HTTP status. The record is total over
// CAPABILITY_ERRORS, so adding a code to the taxonomy is a compile error here until it's mapped.
// ENDPOINT_PAUSED / TARGET_UNREACHABLE are for the future replay capability — mapped now for
// completeness so the surface never has to grow a partial mapping later.
const STATUS: Record<CapabilityError, number> = {
  NOT_FOUND: 404,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  VALIDATION_ERROR: 400,
  RATE_LIMITED: 429,
  ENDPOINT_PAUSED: 409,
  TARGET_UNREACHABLE: 502,
};

export function httpStatusForCapabilityError(code: CapabilityError): number {
  return STATUS[code];
}
