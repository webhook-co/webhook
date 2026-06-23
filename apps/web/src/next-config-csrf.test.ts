import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// CSRF posture guard for the dashboard server actions.
//
// The `app.` credential-mutation server actions (createApiKey / revokeApiKey / revokeGrant) are POST
// server actions. Next 16 enforces a same-origin check on server actions (Origin vs Host) WHEN
// `experimental.serverActions.allowedOrigins` is unset — that default is the CSRF defense, on top of
// the per-action `verifySession`. Widening `allowedOrigins` (e.g. to a wildcard or a cross-origin host)
// would silently disable that same-origin enforcement.
//
// This pins the config so a future edit can't open it without tripping a test (and a deliberate
// justification). It's a config tripwire, not a substitute for Next's framework-level enforcement.
// vitest runs with cwd = the apps/web package root, where next.config.ts lives. A wrong path throws
// ENOENT, failing the test loudly rather than passing vacuously.
const CONFIG_SRC = readFileSync(join(process.cwd(), "next.config.ts"), "utf8");

describe("dashboard server-action CSRF config", () => {
  it("does not widen serverActions.allowedOrigins (keeps Next's same-origin guard)", () => {
    // Strip line/block comments so a note mentioning the knob can't trip the guard.
    const code = CONFIG_SRC.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/allowedOrigins/);
  });
});
