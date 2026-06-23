// Pure helpers for `replay --edit` (the $EDITOR round-trip lives behind the io.editText seam). Decoding
// the captured body for editing + resolving which editor to launch are decisions worth unit-testing on
// their own; the spawn itself is coverage-excluded wiring.

/** Resolve the editor for `--edit`: `$VISUAL` then `$EDITOR` (the conventional precedence). Returns the
 *  trimmed command, or undefined if neither is set — the command then tells the user to set one. */
export function editorFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const visual = env.VISUAL?.trim();
  if (visual !== undefined && visual.length > 0) return visual;
  const editor = env.EDITOR?.trim();
  return editor !== undefined && editor.length > 0 ? editor : undefined;
}

/** Decode a captured body to editable UTF-8 text, or null when it isn't valid UTF-8 (a binary payload —
 *  `--edit` refuses those rather than mangle bytes through a text editor). */
export function decodeEditableBody(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Reconcile the editor's saved text against the original. Most editors append a trailing newline on save,
 * so a payload with no trailing newline comes back changed even on a no-op `:wq`. Treat a difference of
 * ONLY a single trailing newline (either direction) as unchanged — `changed:false` then means "forward the
 * original bytes exactly, no stale-signature warning", matching a plain replay. Any other difference is a
 * real edit, returned verbatim.
 */
export function applyEdit(original: string, edited: string): { text: string; changed: boolean } {
  const stripOneTrailingNewline = (s: string): string => (s.endsWith("\n") ? s.slice(0, -1) : s);
  if (stripOneTrailingNewline(edited) === stripOneTrailingNewline(original)) {
    return { text: original, changed: false };
  }
  return { text: edited, changed: true };
}
