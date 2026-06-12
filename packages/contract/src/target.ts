import { z } from "zod";

// The replay target is a CLOSED union (H6): today the only target is the developer's
// localhost via the CLI tunnel. There is deliberately NO free-form URL — a remote
// target is a future, separately-scoped `kind` behind a registered allowlist + an
// SSRF guard. Keeping the union closed now prevents events.replay from becoming a
// confused-deputy SSRF vector (especially via an MCP agent).
export const TargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("localhost-tunnel"), sessionId: z.string().min(1) }),
]);
export type Target = z.infer<typeof TargetSchema>;
