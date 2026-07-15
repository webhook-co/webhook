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

  it("shows the bound org {id,slug,name} for a grant that carries an orgId", async () => {
    const ORG = { id: "org_1", slug: "acme", name: "Acme Inc" };
    const apps = await listConnectedApps(
      {
        listUserGrants: async () => [grant({ orgId: "org_1" })],
        lookupClientName: async () => null,
        resolveOrgIdentity: async () => ORG,
      },
      "usr_1",
    );
    expect(apps[0]!.org).toEqual(ORG);
  });

  it("omits org for a LEGACY grant with no orgId (never calls the resolver)", async () => {
    let calls = 0;
    const apps = await listConnectedApps(
      {
        listUserGrants: async () => [grant()], // no orgId
        lookupClientName: async () => null,
        resolveOrgIdentity: async () => {
          calls++;
          return { id: "x", slug: "x", name: "X" };
        },
      },
      "usr_1",
    );
    expect(apps[0]!.org).toBeUndefined();
    expect(calls).toBe(0);
  });

  it("omits org when the resolver returns null or faults (best-effort, never fails the list)", async () => {
    const nulled = await listConnectedApps(
      {
        listUserGrants: async () => [grant({ orgId: "org_gone" })],
        lookupClientName: async () => null,
        resolveOrgIdentity: async () => null,
      },
      "usr_1",
    );
    expect(nulled[0]!.org).toBeUndefined();

    const faulted = await listConnectedApps(
      {
        listUserGrants: async () => [grant({ orgId: "org_1" })],
        lookupClientName: async () => null,
        resolveOrgIdentity: async () => {
          throw new Error("tenant read blipped");
        },
      },
      "usr_1",
    );
    expect(faulted[0]!.org).toBeUndefined();
  });

  it("does NOT hang the list on a stalled org read — abandons at the timeout, org omitted", async () => {
    const started = Date.now();
    const apps = await listConnectedApps(
      {
        listUserGrants: async () => [grant({ orgId: "org_1" })],
        lookupClientName: async () => null,
        resolveOrgIdentity: () => new Promise<never>(() => {}), // never settles
      },
      "usr_1",
      20, // small bound for the test
    );
    expect(apps[0]!.org).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1_000); // returned promptly, not hung
  });

  it("resolves each distinct org only ONCE across many grants (dedup by orgId)", async () => {
    let reads = 0;
    const apps = await listConnectedApps(
      {
        listUserGrants: async () => [
          grant({ id: "g1", clientId: "https://a.dev/c.json", orgId: "org_1" }),
          grant({ id: "g2", clientId: "https://b.dev/c.json", orgId: "org_1" }),
          grant({ id: "g3", clientId: "https://c.dev/c.json", orgId: "org_1" }),
        ],
        lookupClientName: async () => null,
        resolveOrgIdentity: async (id) => {
          reads++;
          return { id, slug: "acme", name: "Acme" };
        },
      },
      "usr_1",
    );
    expect(apps.every((a) => a.org?.slug === "acme")).toBe(true);
    expect(reads).toBe(1); // one read for the shared org, not three
  });
});
