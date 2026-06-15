import { redactSecret } from "@webhook-co/shared";

import type { StoredCredential } from "../config/schema.js";
import { CliError } from "../errors.js";

// The output-formatting seam. Commands return structured data; this renders it as text or
// JSON so every surface (and CI) gets the same shape. JSON output makes the CLI scriptable
// and mirrors what MCP/API return (capability parity). Color is threaded for future ANSI.
export type OutputFormat = "text" | "json";

export function resolveFormat(flag: OutputFormat | undefined): OutputFormat {
  return flag ?? "text";
}

export function renderJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** A non-reversible display handle — reuses the shared loggable-view redactor. */
export function redactCredential(cred: StoredCredential): string {
  return redactSecret(cred.apiKey);
}

/**
 * One voice-compliant line for an error: what happened (and, for CliErrors, why/what next).
 * Never a stack trace or ANSI codes. (Color is reserved for a future styled renderer.)
 */
export function formatCliError(error: unknown, _opts: { color: boolean }): string {
  if (error instanceof CliError) return error.userMessage;
  if (error instanceof Error) return error.message;
  return String(error);
}
