import { readFileSync, writeFileSync } from "node:fs";

import { CAPABILITIES, requiredSurfaces } from "@webhook-co/contract";
import { describe, expect, it } from "vitest";

import { buildOpenApiDocument, type JsonObject } from "./generate.js";
import { ROUTES, pathParamNames } from "./routes.js";

const doc = buildOpenApiDocument();
const GOLDEN = new URL("./openapi.json", import.meta.url);

// Regenerate the committed golden when WEBHOOK_OPENAPI_WRITE=1 (the package `generate` script). Otherwise
// the golden is compared byte-for-byte below, so an un-regenerated drift fails CI with the spec diff shown.
if (process.env.WEBHOOK_OPENAPI_WRITE) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- GOLDEN is a fixed module-relative URL.
  writeFileSync(GOLDEN, JSON.stringify(doc, null, 2) + "\n");
}

/** Collect every `$ref` string anywhere in the document. */
function collectRefs(node: unknown, acc: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const v of node) collectRefs(v, acc);
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === "$ref" && typeof v === "string") acc.push(v);
      else collectRefs(v, acc);
    }
  }
  return acc;
}

/** Every schema-position object that is exactly `{}` — a leaked "any" (lossy) schema. */
function countEmptySchemas(node: unknown, acc = { n: 0 }): { n: number } {
  if (Array.isArray(node)) {
    for (const v of node) countEmptySchemas(v, acc);
  } else if (node && typeof node === "object") {
    if (Object.keys(node).length === 0) acc.n += 1;
    for (const v of Object.values(node)) countEmptySchemas(v, acc);
  }
  return acc;
}

const paths = doc.paths as Record<string, Record<string, JsonObject>>;
const components = doc.components as {
  schemas: Record<string, JsonObject>;
  responses: Record<string, JsonObject>;
  securitySchemes: JsonObject;
};

describe("OpenAPI document — top-level shape", () => {
  it("is OpenAPI 3.1 with the 2020-12 dialect + a production server + bearer security", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.jsonSchemaDialect).toBe("https://json-schema.org/draft/2020-12/schema");
    expect((doc.servers as JsonObject[])[0]).toMatchObject({ url: "https://api.webhook.co" });
    expect(doc.security).toEqual([{ bearerAuth: [] }]);
    expect(components.securitySchemes.bearerAuth).toMatchObject({ type: "http", scheme: "bearer" });
  });
});

describe("drift guard L2 — the paths bijection with the route manifest", () => {
  it("has exactly one operation per route (no gaps, no extras)", () => {
    const operationCount = Object.values(paths).reduce(
      (n, item) =>
        n + Object.keys(item).filter((k) => ["get", "post", "delete"].includes(k)).length,
      0,
    );
    expect(operationCount).toBe(ROUTES.length);
  });

  it("maps every route to its verb+path, and every operation carries the manifest metadata", () => {
    for (const route of ROUTES) {
      const item = paths[route.path];
      expect(item, `missing path ${route.path}`).toBeDefined();
      const op = item[route.method.toLowerCase()];
      expect(op, `missing ${route.method} ${route.path}`).toBeDefined();
      expect(op.operationId).toBeTruthy();
      expect(op.summary).toBe(route.summary);
      expect(op.security).toEqual([{ bearerAuth: [] }]);
      // Success is always 200 — never a 201/204 leak.
      const successStatuses = Object.keys(op.responses as JsonObject).filter((s) =>
        s.startsWith("2"),
      );
      expect(successStatuses).toEqual(["200"]);
    }
  });

  it("declares every path param + flags body routes with a request component", () => {
    for (const route of ROUTES) {
      const op = paths[route.path][route.method.toLowerCase()];
      const params = (op.parameters as JsonObject[] | undefined) ?? [];
      const declaredPath = params.filter((p) => p.in === "path").map((p) => p.name);
      expect(declaredPath.sort()).toEqual(pathParamNames(route.path).sort());
      if (route.body && route.capability !== null) {
        expect(op.requestBody).toBeDefined();
        const ref = ((op.requestBody as JsonObject).content as JsonObject)[
          "application/json"
        ] as JsonObject;
        expect((ref.schema as JsonObject).$ref).toMatch(/#\/components\/schemas\/.+Request$/);
      } else {
        expect(op.requestBody).toBeUndefined();
      }
    }
  });
});

describe("drift guard L1 — schema completeness + integrity", () => {
  it("exposes every API-surface capability as an operation (via responseRef)", () => {
    const apiCaps = CAPABILITIES.filter((c) => requiredSurfaces(c).includes("api")).map(
      (c) => c.name,
    );
    const operationIds = Object.values(paths).flatMap((item) =>
      Object.values(item).map((op) => (op as JsonObject).operationId as string),
    );
    // Every capability has an operation (operationId is the camelCased capability name).
    for (const name of apiCaps) {
      const opId = name
        .split(".")
        .map((p, i) => (i === 0 ? p : p.charAt(0).toUpperCase() + p.slice(1)))
        .join("");
      expect(operationIds, `no operation for ${name}`).toContain(opId);
    }
  });

  it("has no dangling $ref (every ref resolves to a defined component)", () => {
    const refs = collectRefs(doc);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      const m = /^#\/components\/(schemas|responses)\/(.+)$/.exec(ref);
      expect(m, `malformed ref ${ref}`).not.toBeNull();
      const [, kind, name] = m!;
      const bag = kind === "schemas" ? components.schemas : components.responses;
      expect(bag[name], `dangling ref ${ref}`).toBeDefined();
    }
  });

  it("emits no empty (any) schema — the fail-closed date override held", () => {
    // Empty objects are only legal in a handful of non-schema spots (e.g. security requirement values);
    // in practice the derived doc has none, which proves no unrepresentable node leaked as `{}`.
    expect(countEmptySchemas(components.schemas).n).toBe(0);
  });

  it("renders z.coerce.date() fields as date-time strings (e.g. Endpoint.createdAt)", () => {
    const endpoint = components.schemas.Endpoint;
    const createdAt = (endpoint.properties as Record<string, JsonObject>).createdAt;
    expect(createdAt).toEqual({ type: "string", format: "date-time" });
  });

  it("hoists the provider enum into a shared component (not inlined per usage)", () => {
    expect(components.schemas.Provider).toBeDefined();
    // EventSummary.provider references the Provider component rather than inlining 100+ values.
    const provider = (components.schemas.EventSummary.properties as Record<string, JsonObject>)
      .provider;
    const refs = collectRefs(provider);
    expect(refs).toContain("#/components/schemas/Provider");
  });
});

describe("drift guard L2 — error responses match what the server actually returns", () => {
  // The auth gate 403s every scoped capability route and 400s every route that validates input, regardless
  // of the capability's declared error taxonomy. The spec must document those, or it under-declares (an SDK
  // gets no 403/400 branch). This cross-checks the same behavior apps/api's L3 conformance test asserts.
  it("documents 401 + 500 on every operation", () => {
    for (const route of ROUTES) {
      const op = paths[route.path][route.method.toLowerCase()];
      const codes = Object.keys(op.responses as JsonObject);
      expect(codes, `${route.method} ${route.path}`).toEqual(
        expect.arrayContaining(["401", "500"]),
      );
    }
  });

  it("documents 403 on every capability route (the scope gate), but NOT on the scope-free whoami", () => {
    for (const route of ROUTES) {
      const op = paths[route.path][route.method.toLowerCase()];
      const codes = Object.keys(op.responses as JsonObject);
      if (route.capability === null) expect(codes).not.toContain("403");
      else expect(codes, `${route.method} ${route.path}`).toContain("403");
    }
  });

  it("documents 400 on every route that validates a path/query/body (e.g. events.replay's body)", () => {
    for (const route of ROUTES) {
      const validates =
        pathParamNames(route.path).length > 0 || (route.query?.length ?? 0) > 0 || route.body;
      if (!validates) continue;
      const op = paths[route.path][route.method.toLowerCase()];
      expect(Object.keys(op.responses as JsonObject), `${route.method} ${route.path}`).toContain(
        "400",
      );
    }
  });
});

describe("drift guard — golden snapshot", () => {
  it("matches the committed openapi.json byte-for-byte (regenerate with pnpm --filter @webhook-co/openapi generate)", () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- GOLDEN is a fixed module-relative URL.
    const golden = readFileSync(GOLDEN, "utf8");
    expect(golden).toBe(JSON.stringify(doc, null, 2) + "\n");
  });
});
