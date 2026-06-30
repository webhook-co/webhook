import { z } from "zod";

// The replay target is a CLOSED union — there is deliberately NO free-form URL, so events.replay can't
// become a confused-deputy SSRF vector (especially via an MCP agent). Two kinds:
//   * `localhost-tunnel` — the developer's localhost via the CLI tunnel (the CLI performs the POST).
//   * `destination` — a REMOTE delivery to a PRE-REGISTERED replay_destinations row, referenced BY ID
//     (never a raw URL). The server delivers it behind the engine's connect-time SSRF guard (ADR-0081).
// Adding the remote kind was the deliberate, ADR-reviewed change ADR-0005 anticipated.
export const TargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("localhost-tunnel"), sessionId: z.string().min(1) }),
  z.object({ kind: z.literal("destination"), destinationId: z.uuid() }),
]);
export type Target = z.infer<typeof TargetSchema>;
