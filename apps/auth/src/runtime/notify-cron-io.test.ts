import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runNotificationDrain } from "./notify-cron";

// The notification drain's I/O GLUE. notify-cron.test.ts covers the pure core (drainNotifications) through
// injected deps; this file covers the wrapper that builds those deps — the env guard, the structured log
// lines, pool close in a finally, and that no credential reaches a log sink on ANY path.
//
// The last of those is why this file exists. runNotificationDrain logs `error.message` from THREE sites, and
// two of them run with the Hyperdrive connection string — which embeds a role password — live in scope.
// They are routed through safeErrorMessage; without a test at THIS call site, reverting them to raw
// error.message would stay green while undoing the no-secrets defence on this path. (Its sibling
// sweep-cron.test.ts pins the same property for the expiry sweep.)

const { createClient, listPendingNotifications, markNotificationSent, readSecretBinding } =
  vi.hoisted(() => ({
    createClient: vi.fn(),
    listPendingNotifications: vi.fn(),
    markNotificationSent: vi.fn(),
    readSecretBinding: vi.fn(),
  }));

vi.mock("@webhook-co/db", () => ({
  createClient,
  listPendingNotifications,
  markNotificationSent,
}));
vi.mock("@webhook-co/shared", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readSecretBinding,
}));

const CONNECTION = "postgres://webhook_notifier:SUPER_SECRET@db.invalid/neondb";
const validEnv = {
  HYPERDRIVE_NOTIFIER: { connectionString: CONNECTION },
  RESEND_API_KEY: "re_test",
};

function captureLogs(): string[] {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => {
    lines.push(line);
  });
  return lines;
}

const messages = (lines: readonly string[]): string[] =>
  lines.map((line) => (JSON.parse(line) as { message: string }).message);

function fakeSql(endBehaviour: "ok" | "throws" = "ok") {
  const state = { ended: false };
  return {
    state,
    client: {
      end: vi.fn(async () => {
        state.ended = true;
        if (endBehaviour === "throws") throw new Error(`pool close failed for ${CONNECTION}`);
      }),
    },
  };
}

beforeEach(() => {
  createClient.mockReset();
  listPendingNotifications.mockReset();
  markNotificationSent.mockReset();
  readSecretBinding.mockReset();
  readSecretBinding.mockResolvedValue("re_test");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runNotificationDrain — unprovisioned deployments are a clean no-op", () => {
  it("returns null and logs when the Hyperdrive binding is absent", async () => {
    const lines = captureLogs();

    await expect(runNotificationDrain({ RESEND_API_KEY: "re_test" })).resolves.toBeNull();

    expect(messages(lines)).toEqual(["auth.notify.cron.error"]);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("returns null when the Resend key resolves empty, without opening a connection", async () => {
    readSecretBinding.mockResolvedValue("");
    const lines = captureLogs();

    await expect(runNotificationDrain(validEnv)).resolves.toBeNull();

    expect(messages(lines)).toEqual(["auth.notify.cron.error"]);
    expect(createClient).not.toHaveBeenCalled();
  });
});

describe("runNotificationDrain — the provisioned path", () => {
  it("drains over the notifier binding, logs the result, and closes the pool", async () => {
    const { state, client } = fakeSql();
    createClient.mockReturnValue(client);
    listPendingNotifications.mockResolvedValue([]);
    const lines = captureLogs();

    await expect(runNotificationDrain(validEnv)).resolves.not.toBeNull();

    // The notifier's OWN binding — it carries the least-privilege webhook_notifier credential.
    expect(createClient).toHaveBeenCalledWith(CONNECTION, { max: 1 });
    expect(messages(lines)).toContain("auth.notify.cron");
    expect(state.ended).toBe(true);
  });

  it("swallows a database failure, returns null, and STILL closes the pool", async () => {
    const { state, client } = fakeSql();
    createClient.mockReturnValue(client);
    listPendingNotifications.mockRejectedValue(new Error("deadlock detected"));
    const lines = captureLogs();

    await expect(runNotificationDrain(validEnv)).resolves.toBeNull();

    expect(messages(lines)).toContain("auth.notify.cron.error");
    expect(state.ended).toBe(true);
  });

  it("never leaks the connection string on the RUNTIME failure path", async () => {
    // The path that matters: `validated` exists here, so the credential-bearing connection string is in
    // scope and an error log that carried it would leak. Revert this site to a raw error.message and this
    // fails. (no-secrets)
    const { client } = fakeSql();
    createClient.mockReturnValue(client);
    listPendingNotifications.mockRejectedValue(new Error(`connection to ${CONNECTION} failed`));
    const lines = captureLogs();

    await expect(runNotificationDrain(validEnv)).resolves.toBeNull();

    expect(lines).not.toHaveLength(0);
    for (const line of lines) expect(line).not.toContain("SUPER_SECRET");
  });

  it("never leaks the connection string from the POOL-CLOSE failure path either", async () => {
    // The third log site, in the finally. It runs after everything else and is the easiest to forget.
    const { client } = fakeSql("throws");
    createClient.mockReturnValue(client);
    listPendingNotifications.mockResolvedValue([]);
    const lines = captureLogs();

    await runNotificationDrain(validEnv);

    expect(messages(lines)).toContain("auth.notify.cron.pool_close_error");
    for (const line of lines) expect(line).not.toContain("SUPER_SECRET");
  });
});
