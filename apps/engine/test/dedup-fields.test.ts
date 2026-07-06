import { describe, expect, it } from "vitest";

import { evaluateFields } from "../src/dedup-fields";

const enc = (s: string) => new TextEncoder().encode(s);
const url = new URL("https://wbhk.my/whep_tok?name=Sourabh&status=good");

function keyBytes(res: ReturnType<typeof evaluateFields>): string | null {
  return res.kind === "key"
    ? [...res.bytes].map((b) => b.toString(16).padStart(2, "0")).join("")
    : null;
}

describe("evaluateFields — bounded field extraction", () => {
  it("extracts a single body scalar into a stable key", () => {
    const a = evaluateFields(enc(`{"data":{"id":"abc"},"ts":1}`), [], url, ["body.data.id"], []);
    const b = evaluateFields(enc(`{"ts":2,"data":{"id":"abc"}}`), [], url, ["body.data.id"], []);
    expect(a.kind).toBe("key");
    // Same selected value, different surrounding/volatile fields + key order → SAME key.
    expect(keyBytes(a)).toBe(keyBytes(b));
  });

  it("produces different keys for different selected values", () => {
    const a = evaluateFields(enc(`{"id":"x"}`), [], url, ["body.id"], []);
    const b = evaluateFields(enc(`{"id":"y"}`), [], url, ["body.id"], []);
    expect(keyBytes(a)).not.toBe(keyBytes(b));
  });

  it("keys on header and query roots", () => {
    const h1 = evaluateFields(enc(``), [["x-event-id", "e1"]], url, ["headers.x-event-id"], []);
    const h2 = evaluateFields(enc(``), [["x-event-id", "e2"]], url, ["headers.x-event-id"], []);
    expect(keyBytes(h1)).not.toBe(keyBytes(h2));
    const q1 = evaluateFields(enc(``), [], new URL("https://wbhk.my/t?id=1"), ["query.id"], []);
    const q2 = evaluateFields(enc(``), [], new URL("https://wbhk.my/t?id=2"), ["query.id"], []);
    expect(keyBytes(q1)).not.toBe(keyBytes(q2));
  });

  it("expands array wildcards deterministically", () => {
    const a = evaluateFields(
      enc(`{"items":[{"sku":"a"},{"sku":"b"}]}`),
      [],
      url,
      ["body.items[*].sku"],
      [],
    );
    const b = evaluateFields(
      enc(`{"items":[{"sku":"a"},{"sku":"b"}]}`),
      [],
      url,
      ["body.items[*].sku"],
      [],
    );
    expect(a.kind).toBe("key");
    expect(keyBytes(a)).toBe(keyBytes(b));
    const c = evaluateFields(
      enc(`{"items":[{"sku":"a"},{"sku":"c"}]}`),
      [],
      url,
      ["body.items[*].sku"],
      [],
    );
    expect(keyBytes(a)).not.toBe(keyBytes(c));
  });

  it("FAIL-SAFE: a missing configured field yields `unique` (never over-collapse)", () => {
    expect(evaluateFields(enc(`{"other":1}`), [], url, ["body.id"], []).kind).toBe("unique");
  });

  it("FAIL-SAFE: a non-JSON body with a body path configured yields `unique`", () => {
    expect(evaluateFields(enc(`not json`), [], url, ["body.id"], []).kind).toBe("unique");
  });

  it("does not parse the body when only header/query/path paths are configured", () => {
    // A non-JSON body must NOT force a fallback when no body path is used.
    const res = evaluateFields(enc(`\x00\x01binary`), [["x-id", "e1"]], url, ["headers.x-id"], []);
    expect(res.kind).toBe("key");
  });

  it("FALLBACK: a body over the size gate yields `content` (bounded, collapses identical)", () => {
    const big = enc(`{"id":"` + "a".repeat(70_000) + `"}`);
    expect(evaluateFields(big, [], url, ["body.id"], []).kind).toBe("content");
  });

  it("FALLBACK: exceeding the extracted-value cap yields `content`", () => {
    const items = Array.from({ length: 300 }, (_, i) => `"v${i}"`).join(",");
    expect(evaluateFields(enc(`{"tags":[${items}]}`), [], url, ["body.tags[*]"], []).kind).toBe(
      "content",
    );
  });

  it("excludes matching leaves from the key", () => {
    const body = enc(`{"id":"x","items":[{"sku":"a","ts":1},{"sku":"b","ts":2}]}`);
    const inc = ["body.items[*].sku", "body.items[*].ts"];
    const withTs = evaluateFields(body, [], url, inc, []);
    const excl = evaluateFields(body, [], url, inc, ["body.items[*].ts"]);
    const other = evaluateFields(
      enc(`{"id":"x","items":[{"sku":"a","ts":9},{"sku":"b","ts":8}]}`),
      [],
      url,
      inc,
      ["body.items[*].ts"],
    );
    // excluding ts: two payloads (same skus, different ts) collapse to the same key.
    expect(excl.kind).toBe("key");
    expect(keyBytes(excl)).toBe(keyBytes(other));
    // ...and excluding ts changes the key vs including it.
    expect(keyBytes(withTs)).not.toBe(keyBytes(excl));
  });

  it("does not confuse two distinct paths that share a value (paths are framed)", () => {
    const body = enc(`{"a":{"id":"1"},"b":{"id":"1"}}`);
    const onA = evaluateFields(body, [], url, ["body.a.id"], []);
    const both = evaluateFields(body, [], url, ["body.a.id", "body.b.id"], []);
    expect(keyBytes(onA)).not.toBe(keyBytes(both));
  });
});
