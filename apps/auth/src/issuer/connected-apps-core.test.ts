import { describe, expect, it } from "vitest";

import {
  listConnectedApps,
  type ListConnectedAppsDeps,
  type RawGrant,
} from "./connected-apps-core";

const grant = (over: Partial<RawGrant> = {}): RawGrant => ({
  id: "grant_1",
  clientId: "https://claude.ai/oauth/claude-code-client-metadata",
  scope: ["events:read"],
  createdAt: 1000,
  ...over,
});

function deps(
  grants: RawGrant[],
  names: Record<string, string | null> = {},
): ListConnectedAppsDeps {
  return {
    listUserGrants: async () => grants,
    lookupClientName: async (clientId) => names[clientId] ?? null,
  };
}

describe("listConnectedApps", () => {
  it("projects a CIMD grant with the proven identity domain + verified badge", async () => {
    const apps = await listConnectedApps(
      deps([grant()], {
        "https://claude.ai/oauth/claude-code-client-metadata": "Claude Code",
      }),
      "usr_1",
    );
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({
      grantId: "grant_1",
      clientName: "Claude Code",
      identityDomain: "claude.ai",
      verified: true,
      scopes: ["events:read"],
      createdAt: 1000,
    });
  });

  it("shows an arbitrary CIMD client unverified with its identity domain", async () => {
    const apps = await listConnectedApps(
      deps([grant({ clientId: "https://acme.dev/client.json" })], {
        "https://acme.dev/client.json": "Acme Tool",
      }),
      "usr_1",
    );
    expect(apps[0]).toMatchObject({
      clientName: "Acme Tool",
      identityDomain: "acme.dev",
      verified: false,
    });
  });

  it("handles an opaque DCR client — no identity domain, unverified, falls back to the id for the name", async () => {
    const apps = await listConnectedApps(deps([grant({ clientId: "cli_opaque" })]), "usr_1");
    expect(apps[0]).toMatchObject({
      clientId: "cli_opaque",
      clientName: "cli_opaque",
      identityDomain: null,
      verified: false,
    });
  });

  it("sanitizes an attacker-controlled client name (bidi/control stripped)", async () => {
    const apps = await listConnectedApps(
      deps([grant({ clientId: "https://acme.dev/c.json" })], {
        "https://acme.dev/c.json": `Acme${String.fromCodePoint(0x202e)}evil`,
      }),
      "usr_1",
    );
    expect(apps[0]!.clientName).toBe("Acmeevil");
  });

  it("returns newest-first", async () => {
    const apps = await listConnectedApps(
      deps([
        grant({ id: "old", clientId: "https://a.dev/c.json", createdAt: 100 }),
        grant({ id: "new", clientId: "https://b.dev/c.json", createdAt: 900 }),
      ]),
      "usr_1",
    );
    expect(apps.map((a) => a.grantId)).toEqual(["new", "old"]);
  });

  it("returns an empty list when the user has no grants", async () => {
    expect(await listConnectedApps(deps([]), "usr_1")).toEqual([]);
  });
});
