import { z } from "zod";

// The tail "lag" metric: how far a consumer is behind the watermark-bounded head. Lives here in
// shared so the read contract (events.tail output) and the live `/listen` StatusFrame bind ONE
// definition. `backlogCount` is the count of unseen events at/below the gapless watermark strictly
// after the consumer's cursor — computed server-side (a client can't count between opaque cursors)
// and CAPPED: the server stops counting at LISTEN_LAG_CAP + 1, so a returned value greater than
// LISTEN_LAG_CAP means "more than the cap" (render as `<cap>+`) and a weekend backlog never triggers
// an unbounded scan. The cap is shared so a consumer can interpret the over-cap sentinel.

/**
 * The server-side cap on the backlog COUNT probe. A returned `backlogCount` of `LISTEN_LAG_CAP + 1`
 * signals "more than the cap" — the consumer renders it as `${LISTEN_LAG_CAP}+`.
 */
export const LISTEN_LAG_CAP = 10_000;

/** The tail lag metric: capped events-behind, plus an optional advisory wall-clock head delta. */
export const LagSchema = z.object({
  backlogCount: z.number().int().nonnegative(),
  headLagMs: z.number().int().nonnegative().optional(),
});

export type Lag = z.infer<typeof LagSchema>;
