import { uuidv7 } from "uuidv7";

// UUIDv7 ids — time-ordered, edge-generated — for index locality on
// received_at-ordered scans and a stable cursor tiebreaker. One generator so
// every surface mints ids the same way.

/** Mint a new time-ordered UUIDv7 (lowercase canonical form). */
export function newId(): string {
  return uuidv7();
}

export { uuidv7 };
