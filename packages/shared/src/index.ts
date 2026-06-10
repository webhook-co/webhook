export const SERVICE_NAME = "webhook" as const;

/**
 * Redacts the secret portion of a webhook signing key for safe logging.
 * Keeps only a short, non-reversible prefix so logs never leak full secrets
 * (compliance-by-design: PII/secret scrubbing from logs).
 */
export function redactSecret(secret: string, visiblePrefix = 4): string {
  if (secret.length === 0) {
    return "";
  }
  const prefix = secret.slice(0, Math.min(visiblePrefix, secret.length));
  return `${prefix}${"*".repeat(Math.max(secret.length - prefix.length, 0))}`;
}
