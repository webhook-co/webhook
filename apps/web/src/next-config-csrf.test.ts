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

// Strip line/block comments so a note mentioning a knob can't trip a guard.
const CODE = CONFIG_SRC.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

describe("dashboard server-action CSRF config", () => {
  it("does not widen serverActions.allowedOrigins (keeps Next's same-origin guard)", () => {
    expect(CODE).not.toMatch(/allowedOrigins/);
  });
});

describe("dashboard CSP dev-relaxation gate", () => {
  it("keys the dev CSP relaxation on the build phase, not a runtime env var (fail-closed)", () => {
    // The 'unsafe-eval' + HMR-websocket relaxation must gate on Next's build PHASE
    // (PHASE_DEVELOPMENT_SERVER — a build-time constant passed only by `next dev`), NEVER on
    // process.env.NODE_ENV. NODE_ENV is an env var a misconfigured production build could leave
    // unset/"development", which would ship 'unsafe-eval' to real users. Phase-gating is fail-closed:
    // any non-dev phase (every `next build`/deploy) yields the tight policy.
    expect(CODE).toMatch(/PHASE_DEVELOPMENT_SERVER/);
    expect(CODE).not.toMatch(/NODE_ENV/);
  });
});
