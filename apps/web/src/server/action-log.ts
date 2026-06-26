import "server-only";

/**
 * Surface the real cause of an otherwise-swallowed server-action failure to Workers observability —
 * scrubbed: the error name/message + (for a PG error) its SQLSTATE code, never a secret/plaintext/pepper/
 * token or a row value. The user still gets a generic message; this keeps a credential- or
 * endpoint-mutation failure diagnosable instead of silent (a silent `catch {}` is what hid the
 * `(void 0) is not a function` bundling bug on these surfaces). Shared by every app. mutation action so the
 * scrubbing policy lives in ONE place (a compliance change can't miss a copy). Not a "use server" module,
 * so it may export this sync helper.
 */
export function logActionError(event: string, error: unknown): void {
  const e = error as { name?: string; message?: string; code?: string };
  console.error(
    JSON.stringify({
      message: event,
      name: e?.name,
      error: e?.message ?? String(error),
      code: e?.code,
    }),
  );
}
