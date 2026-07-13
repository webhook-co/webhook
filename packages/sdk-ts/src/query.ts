// Query-string construction shared by the list endpoints. Absent keys are omitted (never sent as empty);
// an array value rides as a REPEATED param (`?provider=a&provider=b`) — the multi-select shape the API
// reads back with `getAll` — and an empty array contributes nothing.

export type QueryValue = string | number | boolean | readonly string[] | null | undefined;

export function withQuery(path: string, params: Record<string, QueryValue>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    // null omits, exactly like undefined: a caught-up `triggers.wait` returns `nextCursor: null` and the
    // contract makes the cursor input nullable so that value round-trips back in. Serialising it would send
    // the literal string "null" and earn a VALIDATION_ERROR.
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) for (const v of value) query.append(key, v);
    else query.set(key, String(value));
  }
  const qs = query.toString();
  return qs.length > 0 ? `${path}?${qs}` : path;
}
