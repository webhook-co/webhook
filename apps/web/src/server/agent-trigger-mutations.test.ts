import { describe, expect, it, vi } from "vitest";

import {
  createTrigger,
  revokeTrigger,
  TriggerEndpointNotFoundError,
  type AgentTriggerDeps,
} from "./agent-trigger-mutations";

// The mutations seam is tested with INJECTED deps, so no pool / audit-key / env is touched. It's thin glue —
// map the action's input to the Lane fn under the org — so the test pins the argument threading + that a
// db-layer throw (endpoint-not-found) propagates for the action layer to translate.

const ORG = "org-1";
const ACTOR = "user-1";
const record = () => ({
  id: "t1",
  orgId: ORG,
  endpointId: "ep1",
  name: "agent",
  createdAt: new Date(0),
  revokedAt: null,
});

describe("createTrigger", () => {
  it("threads (orgId, endpointId, name, actor) to the create dep and returns the record", async () => {
    const deps: AgentTriggerDeps = {
      create: vi.fn(async () => record()),
      revoke: vi.fn(),
    };
    const out = await createTrigger(
      { orgId: ORG, endpointId: "ep1", name: "agent", actor: ACTOR },
      deps,
    );
    expect(deps.create).toHaveBeenCalledWith(ORG, "ep1", "agent", ACTOR);
    expect(out.id).toBe("t1");
  });

  it("defaults a missing name to null", async () => {
    const deps: AgentTriggerDeps = { create: vi.fn(async () => record()), revoke: vi.fn() };
    await createTrigger({ orgId: ORG, endpointId: "ep1", actor: ACTOR }, deps);
    expect(deps.create).toHaveBeenCalledWith(ORG, "ep1", null, ACTOR);
  });

  it("propagates a db-layer endpoint-not-found for the action layer to translate", async () => {
    const deps: AgentTriggerDeps = {
      create: vi.fn(async () => {
        throw new TriggerEndpointNotFoundError("gone");
      }),
      revoke: vi.fn(),
    };
    await expect(
      createTrigger({ orgId: ORG, endpointId: "ep1", actor: ACTOR }, deps),
    ).rejects.toBeInstanceOf(TriggerEndpointNotFoundError);
  });
});

describe("revokeTrigger", () => {
  it("threads (orgId, triggerId, actor) to the revoke dep", async () => {
    const deps: AgentTriggerDeps = { create: vi.fn(), revoke: vi.fn(async () => ({ id: "t1" })) };
    const out = await revokeTrigger({ orgId: ORG, triggerId: "t1", actor: ACTOR }, deps);
    expect(deps.revoke).toHaveBeenCalledWith(ORG, "t1", ACTOR);
    expect(out).toEqual({ id: "t1" });
  });

  it("passes through a null (unknown / cross-org id → NOT_FOUND at the action)", async () => {
    const deps: AgentTriggerDeps = { create: vi.fn(), revoke: vi.fn(async () => null) };
    expect(await revokeTrigger({ orgId: ORG, triggerId: "x", actor: ACTOR }, deps)).toBeNull();
  });
});
