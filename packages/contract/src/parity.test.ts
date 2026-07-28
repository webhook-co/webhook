import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineCapability, requiredSurfaces, SURFACES } from "./capability";
import { CAPABILITIES, triggersCreate } from "./capabilities";
import { assertCapabilityParity, emptyBindings, findParityViolations } from "./parity";

/**
 * Zod marks a strict object by setting its catchall to `never`. There is no public `.isStrict`, and
 * asserting on a parse result alone would let a schema that merely happens to have no extra keys in
 * the fixture pass — so read the marker directly.
 */
function isStrictObject(schema: z.ZodTypeAny): boolean {
  const def = (schema as unknown as { _zod?: { def?: { type?: string; catchall?: unknown } } })._zod
    ?.def;
  if (def?.type !== "object") return false;
  const catchall = def.catchall as { _zod?: { def?: { type?: string } } } | undefined;
  return catchall?._zod?.def?.type === "never";
}

/**
 * Unknown keys on a capability input must be REJECTED, not silently dropped.
 *
 * Zod's default is to strip. That made every surface — API, CLI, MCP, the SDKs — accept a field it
 * did not understand, discard it, and return 200. An agent that invented `eventTypes` on
 * `triggers.create` (a real field, but on the sibling `subscriptions.create`) got a success and a
 * trigger that did not do what it asked. Nothing anywhere said no.
 *
 * Strictness fixes it twice over: `safeParse` returns `unrecognized_keys`, which the handlers map to
 * VALIDATION_ERROR, and `z.toJSONSchema(input, { io: "input" })` starts emitting
 * `additionalProperties: false` — which is what the MCP tool schema and the OpenAPI request bodies
 * advertise, so a client is told the key is illegal BEFORE it sends it rather than after.
 *
 * On MCP the rejection actually lands one layer earlier: the SDK validates against the advertised
 * schema before the handler runs, so a client sees a JSON-RPC InvalidParams rather than the
 * VALIDATION_ERROR envelope. Same refusal, different wrapper — see `apps/mcp/src/mcp-agent.ts`.
 */
describe("capability inputs reject unknown keys", () => {
  it("has capabilities to check", () => {
    expect(CAPABILITIES.length).toBeGreaterThan(0);
  });

  it.each(CAPABILITIES.map((c) => [c.name, c] as const))("%s input is strict", (_name, cap) => {
    expect(isStrictObject(cap.input)).toBe(true);
  });

  /**
   * Top-level strictness is not enough. `defineCapability` only strictens the OUTER object, so a
   * nested one keeps stripping: `events.list` accepted `{filter:{bogus:1}}`, parsed it to
   * `{filter:{}}`, and returned an UNFILTERED page with a 200 — the same lie as the invented
   * `eventTypes`, one level down, on a field whose whole job is to narrow results.
   *
   * Walk every object reachable from an input (through optional/nullable/default/array/union
   * wrappers) and require all of them to be strict. A per-site `z.strictObject` is the fix; this is
   * what stops the next nested `z.object` from re-opening the hole.
   */
  const ROOT = "<root>";

  /**
   * Every object schema reachable from `schema`, as dotted paths, filtered by `flag`.
   *
   * The wrapper coverage IS the guard. An earlier version handled only
   * `innerType`/`element`/`valueType`/`in`/`out`/`options`, so a loose object hidden inside a tuple,
   * an intersection or a `z.lazy` was invisible — and because the only assertion was
   * `expect(walk(...)).toEqual([])`, a walker that returned `[]` unconditionally would have passed
   * every test in this file. The fixture tests below exist to make that impossible: each one plants a
   * known-loose object behind one wrapper kind and requires it to be found.
   */
  function reachableObjects(
    schema: z.ZodTypeAny,
    flag: (s: z.ZodTypeAny) => boolean,
    path = "",
    seen = new Set<unknown>(),
    depth = 0,
  ): string[] {
    if (depth > 20 || seen.has(schema)) return [];
    seen.add(schema);
    const def = (schema as unknown as { _zod?: { def?: Record<string, unknown> } })._zod?.def;
    if (!def) return [];
    const out: string[] = [];
    const recur = (child: unknown, childPath: string): void => {
      if (child)
        out.push(...reachableObjects(child as z.ZodTypeAny, flag, childPath, seen, depth + 1));
    };

    if (def.type === "object") {
      if (flag(schema)) out.push(path === "" ? ROOT : path);
      for (const [key, child] of Object.entries(def.shape as Record<string, z.ZodTypeAny>)) {
        recur(child, path === "" ? key : `${path}.${key}`);
      }
      return out;
    }
    // Single-child wrappers: optional / nullable / default / array / record / pipe / readonly / lazy.
    for (const key of ["innerType", "element", "valueType", "keyType", "in", "out", "rest"]) {
      recur(def[key], path);
    }
    // `lazy` stores a thunk, so it has to be invoked; `depth` is what stops a self-referential one.
    if (typeof def.getter === "function") recur((def.getter as () => z.ZodTypeAny)(), path);
    // Multi-child: unions/discriminated unions (`options`), tuples (`items`).
    for (const key of ["options", "items"]) {
      for (const child of (def[key] as z.ZodTypeAny[] | undefined) ?? []) recur(child, path);
    }
    // Intersections.
    for (const key of ["left", "right"]) recur(def[key], path);
    return out;
  }

  /** Loose objects BELOW the root (the root's strictness is asserted separately). */
  const nestedObjects = (s: z.ZodTypeAny): string[] =>
    reachableObjects(s, (o) => !isStrictObject(o)).filter((p) => p !== ROOT);

  /** Any strict object reachable at all — including the root, which an output must never be. */
  const strictReachable = (s: z.ZodTypeAny): string[] => reachableObjects(s, isStrictObject);

  // POSITIVE tests for the walker. Without these the two `.toEqual([])` assertions above are
  // satisfied by a walker that finds nothing, which is the failure mode they exist to prevent.
  const loose = z.object({ inner: z.string() });
  it.each([
    ["directly nested", z.strictObject({ a: loose })],
    ["inside an array", z.strictObject({ a: z.array(loose) })],
    ["inside optional", z.strictObject({ a: loose.optional() })],
    ["inside nullable+default", z.strictObject({ a: loose.nullable().default(null) })],
    ["inside a record", z.strictObject({ a: z.record(z.string(), loose) })],
    ["inside a union", z.strictObject({ a: z.union([z.string(), loose]) })],
    ["inside a tuple", z.strictObject({ a: z.tuple([loose]) })],
    ["inside an intersection", z.strictObject({ a: z.intersection(loose, z.object({})) })],
    ["inside a lazy", z.strictObject({ a: z.lazy(() => loose) })],
  ])("the walker finds a loose object %s", (_label, schema) => {
    expect(nestedObjects(schema as z.ZodTypeAny)).toContain("a");
  });

  it("the walker reports nothing when every nested object is strict", () => {
    expect(nestedObjects(z.strictObject({ a: z.strictObject({ inner: z.string() }) }))).toEqual([]);
  });

  it("strictReachable finds a strict object nested in an output-shaped schema", () => {
    expect(strictReachable(z.object({ a: z.strictObject({ inner: z.string() }) }))).toContain("a");
    expect(strictReachable(z.object({ a: z.object({ inner: z.string() }) }))).toEqual([]);
  });

  it.each(CAPABILITIES.map((c) => [c.name, c] as const))(
    "%s has no loose nested object",
    (name, cap) => {
      expect(
        nestedObjects(cap.input),
        `${name}: these nested objects still strip unknown keys`,
      ).toEqual([]);
    },
  );

  /**
   * The MIRROR rule, and the more important of the two: an OUTPUT schema must never be strict.
   *
   * Inputs and outputs want opposite things. Rejecting an unknown key on the way IN is a server-side
   * policy, reversible with one deploy. Rejecting one on the way OUT is compiled into every client a
   * user has already installed — `packages/cli/src/api-client.ts` hard-throws "the api returned an
   * unexpected response" on a failed parse, and `CLIENT_MIN_SUPPORTED` is advisory, so there is no
   * mechanism to make anyone upgrade. A strict output means the next additive field we ship breaks
   * every `wbhk` binary in the field, and the only fix is on the user's side.
   *
   * `EndpointSchema.dedupConfig` states this intent in its own docblock, and `sdks/python` is
   * generated with `--extra-fields ignore` for the same reason. This assertion is what stops a shared
   * schema being strictened for an input and silently dragging an output along with it — which is
   * exactly what happened here.
   */
  it.each(CAPABILITIES.map((c) => [c.name, c] as const))(
    "%s output is forward-compatible (nothing reachable from it is strict)",
    (name, cap) => {
      const strictOutputs = strictReachable(cap.output);
      expect(
        strictOutputs,
        `${name}: a strict OUTPUT schema breaks every already-installed client the day we add a field`,
      ).toEqual([]);
    },
  );

  /**
   * `.strict()` overwrites a catchall rather than composing with one: `.catchall(z.string()).strict()`
   * leaves `catchall === never`. So a future capability that deliberately accepts a typed metadata bag
   * would have that intent destroyed here, silently — and the strictness assertion above would PASS,
   * because `.strict()` is what made it true. A guard that cannot see the case it should flag is worse
   * than no guard, so refuse the input instead of quietly rewriting it.
   */
  it("refuses an input that declares a catchall instead of silently overriding it", () => {
    expect(() =>
      defineCapability({
        name: "internal.catchall",
        input: z.object({ a: z.string() }).catchall(z.string()),
        output: z.object({}),
        errors: ["UNAUTHORIZED"],
        auth: { scope: "events:read" },
        semantics: {},
      }),
    ).toThrow(/catchall/i);
  });

  it("rejects an unknown key inside a nested filter object", () => {
    const eventsList = CAPABILITIES.find((c) => c.name === "events.list");
    expect(eventsList, "events.list missing").toBeDefined();
    const result = eventsList!.input.safeParse({ filter: { providerr: ["stripe"] } });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.code).toBe("unrecognized_keys");
  });

  it("rejects an invented key instead of silently dropping it", () => {
    const result = triggersCreate.input.safeParse({
      endpointId: "00000000-0000-4000-8000-000000000000",
      eventTypes: ["payment.succeeded"],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.code).toBe("unrecognized_keys");
  });

  it("still accepts the same input without the invented key", () => {
    const result = triggersCreate.input.safeParse({
      endpointId: "00000000-0000-4000-8000-000000000000",
    });
    expect(result.success).toBe(true);
  });

  it("advertises additionalProperties:false to MCP clients", () => {
    const schema = z.toJSONSchema(triggersCreate.input, { io: "input" }) as {
      additionalProperties?: boolean;
    };
    expect(schema.additionalProperties).toBe(false);
  });
});

/**
 * Every write capability must SAY whether it is destructive; no read capability may.
 *
 * This exists for the MCP `destructiveHint`, which the Anthropic Connectors Directory requires and
 * whose spec default is `true`. So an omission is not a safe default — it silently labels a
 * non-destructive write (creating an endpoint, enabling a destination) as destructive, and a client
 * that gates on the hint would prompt for confirmation on all of them. Deriving it from the
 * capability NAME would be worse: `endpoints.rotate` destroys a working ingest token and
 * `replayDestinations.setOrdered` destroys nothing, and no regex over verbs knows that.
 *
 * Read capabilities are required to stay silent because the hint is only meaningful when
 * `readOnlyHint` is false — declaring it there is a claim with nowhere to land.
 */
describe("destructive semantics are declared, not inferred", () => {
  const isRead = (cap: (typeof CAPABILITIES)[number]): boolean => cap.auth.scope.endsWith(":read");

  it("has both reads and writes to check", () => {
    expect(CAPABILITIES.filter(isRead).length).toBeGreaterThan(5);
    expect(CAPABILITIES.filter((c) => !isRead(c)).length).toBeGreaterThan(5);
  });

  it("every write capability declares `destructive`", () => {
    const undeclared = CAPABILITIES.filter((c) => !isRead(c))
      .filter((c) => typeof c.semantics.destructive !== "boolean")
      .map((c) => c.name);
    expect(
      undeclared,
      "these mutate state but never said whether they destroy anything — MCP defaults the hint to true, so silence mislabels them",
    ).toEqual([]);
  });

  it("no read capability declares `destructive`", () => {
    const overreaching = CAPABILITIES.filter(isRead)
      .filter((c) => c.semantics.destructive !== undefined)
      .map((c) => c.name);
    expect(overreaching, "readOnly tools have nowhere to put a destructiveHint").toEqual([]);
  });

  it("the declaration is not all-one-way", () => {
    const writes = CAPABILITIES.filter((c) => !isRead(c));
    expect(writes.filter((c) => c.semantics.destructive === true).length).toBeGreaterThan(2);
    expect(writes.filter((c) => c.semantics.destructive === false).length).toBeGreaterThan(2);
  });
});

function fullBindings() {
  const b = emptyBindings();
  for (const surface of SURFACES) for (const cap of CAPABILITIES) b[surface].add(cap.name);
  return b;
}

/** Total (capability, required-surface) pairs once documented exemptions are honored. */
const requiredPairs = CAPABILITIES.reduce((n, c) => n + requiredSurfaces(c).length, 0);

describe("capability parity", () => {
  it("passes when every capability is bound on every GA surface", () => {
    expect(() => assertCapabilityParity(CAPABILITIES, fullBindings())).not.toThrow();
  });

  it("flags a capability missing on a surface it is required on", () => {
    const b = fullBindings();
    // events.list is required on mcp (no exemption), so dropping it is a real violation.
    b.mcp.delete("events.list");
    const violations = findParityViolations(CAPABILITIES, b);
    expect(violations).toContainEqual({ capability: "events.list", surface: "mcp" });
  });

  it("does NOT flag a capability that is surfaceExempt on the missing surface", () => {
    const b = fullBindings();
    // events.replay is exempt on mcp (lands in slice 12), so dropping its mcp binding is fine.
    b.mcp.delete("events.replay");
    const violations = findParityViolations(CAPABILITIES, b);
    expect(violations).not.toContainEqual({ capability: "events.replay", surface: "mcp" });
  });

  it("reports exactly the required (capability, surface) pairs when nothing is bound", () => {
    const violations = findParityViolations(CAPABILITIES, emptyBindings());
    // Exemptions shrink the required set below CAPABILITIES.length * SURFACES.length.
    expect(violations).toHaveLength(requiredPairs);
    expect(requiredPairs).toBeLessThan(CAPABILITIES.length * SURFACES.length);
  });

  it("respects a documented surfaceExempt", () => {
    const internalOnly = defineCapability({
      name: "internal.only",
      input: z.object({}),
      output: z.object({}),
      errors: ["UNAUTHORIZED"],
      auth: { scope: "events:read" },
      semantics: {},
      surfaceExempt: { web: "no dashboard view planned", mcp: "not agent-relevant" },
    });
    const b = emptyBindings();
    b.api.add("internal.only");
    b.cli.add("internal.only");
    expect(() => assertCapabilityParity([internalOnly], b)).not.toThrow();
  });

  it("throws a readable error listing violations", () => {
    expect(() => assertCapabilityParity(CAPABILITIES, emptyBindings())).toThrow(
      /parity violations/,
    );
  });
});

// The conformance gate: the capabilities actually bound on each surface TODAY must satisfy
// parity once the documented exemptions are honored. This encodes the live reality so that
// (a) shipping a GA surface without a required capability fails the build, and (b) an
// over-broad exemption — one that excuses a surface that IS in fact bound — is caught too.
// Slices 11/12 bind events.tail/replay on api+mcp and remove those exemptions, updating this
// map in lockstep; the frontend epic adds the web bindings and removes the WEB_DEFERRED ones.
describe("capability parity — current GA surfaces conformance", () => {
  // The real registered sets, mirrored here from each surface:
  //   cli  — packages/cli CAPABILITY_COMMANDS (every command: `listen`/`replay` map tail/replay)
  //   api  — apps/api router (the reads + endpoints.create/delete/rotate writes + events.tail cursor-pull)
  //   mcp  — apps/mcp McpAgent tools (the same set)
  //   web  — apps/web dashboard: endpoints.* management (events.* + audit still deferred to their slices)
  const API_MCP_BOUND = [
    "endpoints.list",
    "endpoints.get",
    "endpoints.create",
    "endpoints.delete",
    "endpoints.rotate",
    // endpoints.update (dedup config, ADR-0104): api + mcp (slice 3), cli (slice 3b), web (slice 4).
    "endpoints.update",
    // Ingest-URL reveal (S8-remainder / ADR-0101): the gated + audited programmatic capability, api+mcp+cli.
    // (The dashboard shows the URL via a separate DB-direct config read, so web is surfaceExempt — see below.)
    "endpoints.revealIngestUrl",
    // Provider-secret management (ADR-0078): full MCP parity (D2) — add/list/revoke on api+mcp+cli.
    "endpoints.addProviderSecret",
    "endpoints.listProviderSecrets",
    "endpoints.revokeProviderSecret",
    "events.list",
    "events.get",
    "events.tail",
    // events.delete (S3): the TOMBSTONE. api+mcp+cli+web parity — MCP-BOUND despite being destructive,
    // with mitigations (single-id, rate limit, audit row per delete, DESTRUCTIVE tool description).
    "events.delete",
    // Deliveries reads (S3 Slice 3 PR3): full api+mcp+cli parity (reading delivery status steers nothing —
    // unlike the subscriptions/destinations WRITE caps, which are mcp-exempt). Web-deferred.
    "deliveries.get",
    "deliveries.list",
    "audit.verify",
    // triggers.* (S5): webhook→agent trigger subscriptions. MCP-BOUND (unlike the egress subscriptions.*
    // above) — a trigger is a read-consumption registration, not egress, so an agent may manage its own.
    // create/list/revoke are ALSO web-bound (S5 dashboard slice — DB-direct server actions, see WEB_BOUND
    // below); only triggers.wait stays web-exempt (the dashboard streams live events over its own WebSocket).
    "triggers.create",
    "triggers.list",
    "triggers.revoke",
    // usage.get (S4.2): the metering usage surface — full api+mcp+cli+web parity (a read that steers
    // nothing; single-dimension events, no prices in the output).
    "usage.get",
    "triggers.wait",
  ];
  // The dashboard surface: endpoints.* (slice 2) + events.list/get (slice 3a) + events.getPayload (slice 3b —
  // the R2 payload viewer + download), all DB-direct server reads. events.tail / events.replay stay
  // web-deferred. audit.verify is now BOUND on web (Lane 2.8 — the /audit page's "Verify chain" button).
  const WEB_BOUND = [
    "audit.verify",
    "endpoints.list",
    "endpoints.get",
    "endpoints.create",
    "endpoints.delete",
    "endpoints.rotate",
    // endpoints.update (dedup config, ADR-0104): the dashboard's Deduplication section (slice 4) binds it
    // via a DB-direct server action (endpoint-actions.ts), so web is no longer exempt.
    "endpoints.update",
    // NOTE: endpoints.revealIngestUrl is NOT web-bound. The dashboard shows the ingest URL, but as endpoint
    // config via a DB-direct session read (endpoint-reveal.ts) — a lighter mechanism than this gated +
    // audited programmatic capability, which is why the capability is surfaceExempt on web (see capabilities.ts).
    "events.list",
    "events.get",
    "events.getPayload",
    // events.delete (S3): the dashboard's event delete — a DB-direct server action (event-actions.ts).
    "events.delete",
    // usage.get (S4.2): the dashboard usage view — a DB-direct server read (usage.ts), like events.list.
    "usage.get",
    // triggers.* (S5 web slice): the dashboard agent-triggers view (list + create + revoke) via DB-direct
    // server actions (agent-trigger-actions.ts). triggers.wait is NOT web-bound (see the note above).
    "triggers.create",
    "triggers.list",
    "triggers.revoke",
  ];
  function liveBindings() {
    const b = emptyBindings();
    for (const cap of CAPABILITIES) b.cli.add(cap.name); // CLI surfaces every command
    for (const name of API_MCP_BOUND) {
      b.api.add(name);
      b.mcp.add(name);
    }
    // events.getPayload is bound on api (+ cli, above) but exempt on mcp (no R2 binding) — slice 12a.
    b.api.add("events.getPayload");
    // events.replay is bound on api (+ cli, above) but exempt on mcp (localhost-tunnel is CLI-intrinsic) — PR3.
    b.api.add("events.replay");
    // replayDestinations.* (ADR-0081): bound on api (+ cli, above), web-deferred + mcp-exempt (an agent
    // must not mutate the SSRF-egress allowlist). api-only here, like events.replay.
    b.api.add("replayDestinations.create");
    b.api.add("replayDestinations.list");
    b.api.add("replayDestinations.delete");
    // Destination lifecycle (S3 Slice 3 PR3b): enable + setOrdered — same api-only + mcp-exempt posture.
    b.api.add("replayDestinations.enable");
    b.api.add("replayDestinations.setOrdered");
    // The destination signing-secret management (ADR-0084, S3 Slice 2): same surface posture (api + cli;
    // web-deferred; mcp-exempt — an agent must not mint/exfiltrate a signing secret).
    b.api.add("replayDestinations.rotateSigningSecret");
    b.api.add("replayDestinations.listSigningSecrets");
    // subscriptions.* (S3 Slice 3): bound on api (+ cli, above), web-deferred + mcp-exempt (an agent must
    // not reconfigure where an org's events are routed/delivered). api-only here, like replayDestinations.
    b.api.add("subscriptions.create");
    b.api.add("subscriptions.list");
    b.api.add("subscriptions.delete");
    // the dashboard surface (DB-direct server actions/reads): endpoints.* (slice 2) + events.list/get (slice 3a).
    for (const name of WEB_BOUND) b.web.add(name);
    return b;
  }

  it("passes parity with the documented exemptions", () => {
    expect(() => assertCapabilityParity(CAPABILITIES, liveBindings())).not.toThrow();
  });

  it("would fail if a read capability were dropped from a required surface", () => {
    const b = liveBindings();
    b.api.delete("events.get");
    expect(() => assertCapabilityParity(CAPABILITIES, b)).toThrow(
      /events\.get is not bound on api/,
    );
  });

  it("keeps exemptions tight: endpoints.* + events.list/get/getPayload require web; tail/replay + audit web-deferred", () => {
    const tail = CAPABILITIES.find((c) => c.name === "events.tail");
    const replay = CAPABILITIES.find((c) => c.name === "events.replay");
    const getPayload = CAPABILITIES.find((c) => c.name === "events.getPayload");
    // events.tail bound on api+mcp as of slice 11 (cursor pull); replay bound on api as of PR3
    // (recording-server-side), mcp still exempt (localhost-tunnel is CLI-intrinsic).
    expect(requiredSurfaces(tail!)).toEqual(["api", "cli", "mcp"]);
    expect(requiredSurfaces(replay!)).toEqual(["api", "cli"]);
    // getPayload is bound on api + cli + web (slice 3b); mcp stays exempt (the McpAgent has no R2 binding).
    expect(requiredSurfaces(getPayload!)).toEqual(["api", "cli", "web"]);
    // The endpoints.* + events.list/get/getPayload capabilities are un-deferred on web; every other
    // capability — events.tail/replay + audit.verify — stays web-deferred until its slice.
    for (const cap of CAPABILITIES) {
      if (WEB_BOUND.includes(cap.name)) {
        expect(requiredSurfaces(cap), `${cap.name} must require web`).toContain("web");
      } else {
        expect(requiredSurfaces(cap), `${cap.name} must not require web yet`).not.toContain("web");
      }
    }
  });
});
