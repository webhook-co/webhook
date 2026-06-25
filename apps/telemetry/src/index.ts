// telemetry.wbhk.my — the wbhk CLI telemetry collector Worker (DIST-14). Thin entry; routing + validation
// live in router.ts (unit-tested). Writes anonymous events to Cloudflare Analytics Engine (the TELEMETRY
// binding) — no database, no PII, cookieless.
import { handleTelemetry, type Env } from "./router.js";

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleTelemetry(request, env);
  },
} satisfies ExportedHandler<Env>;
