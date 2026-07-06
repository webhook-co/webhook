// Ingest-time field-path evaluator for `fields` dedup mode. Runs on the metered hot path over
// UNTRUSTED payloads, so every operation is bounded. The grammar was already validated at config
// write time (packages/shared/dedup-config.ts); here we only extract, within hard limits.
//
// Returns one of three outcomes so the caller never has to guess:
//   - key     : a stable framed byte string to hash (the fields dedup key)
//   - content : degrade to a whole-body content hash (too big / too many values — bounded, still
//               collapses byte-identical retries; never over-collapses distinct payloads)
//   - unique  : FAIL-SAFE — a configured field is missing/unresolvable, so treat the request as a
//               distinct event (a unique key). Over-collapsing (silently dropping a real event) is
//               the worst failure; under-dedup is safe.

import { findHeader, parseFieldPath, type PathSegment } from "@webhook-co/shared";

/** Only attempt body extraction when the body is small enough to parse+traverse cheaply. */
export const MAX_FIELD_BODY_BYTES = 64 * 1024;
/** Total scalar values folded into one key. Beyond this we degrade to content-hash (bounded). */
export const MAX_EXTRACTED_VALUES = 256;
/** Body traversal depth guard (independent of the config-time segment cap). */
export const MAX_PARSE_DEPTH = 32;
/** Total node visits during body traversal — bounds work regardless of array size / match rate. */
export const MAX_TRAVERSAL_STEPS = 4096;

export type FieldEval =
  | { readonly kind: "key"; readonly bytes: Uint8Array }
  | { readonly kind: "content" }
  | { readonly kind: "unique" };

type Headers = ReadonlyArray<readonly [string, string]>;
type ConcreteSeg = { readonly key: string } | { readonly index: number };
interface Extracted {
  readonly root: "headers" | "body" | "query" | "path";
  readonly segments: readonly ConcreteSeg[];
  readonly value: string | number | boolean | null;
}

const utf8Decoder = new TextDecoder();
const utf8Encoder = new TextEncoder();

function isScalar(v: unknown): v is string | number | boolean | null {
  return v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

/** Shared, bounded traversal state — `overflow` signals a degrade-to-content-hash. */
interface CollectState {
  readonly out: Extracted[];
  steps: number;
  overflow: boolean;
}

/** Traverse parsed JSON along body segments, collecting scalar leaves (wildcards expand). */
function collectBody(
  node: unknown,
  segments: readonly PathSegment[],
  i: number,
  prefix: ConcreteSeg[],
  st: CollectState,
  depth: number,
): void {
  if (st.overflow) return;
  if (++st.steps > MAX_TRAVERSAL_STEPS || st.out.length > MAX_EXTRACTED_VALUES) {
    st.overflow = true; // too much work / too many values → caller degrades to content-hash
    return;
  }
  if (depth > MAX_PARSE_DEPTH) return; // deeper than we'll traverse → no value here
  if (i === segments.length) {
    if (isScalar(node)) st.out.push({ root: "body", segments: [...prefix], value: node });
    return;
  }
  const seg = segments[i];
  if (seg === undefined) return;
  if ("key" in seg) {
    if (typeof node !== "object" || node === null || Array.isArray(node)) return;
    const child = (node as Record<string, unknown>)[seg.key];
    if (child === undefined) return;
    collectBody(child, segments, i + 1, [...prefix, { key: seg.key }], st, depth + 1);
    return;
  }
  if ("index" in seg) {
    if (!Array.isArray(node) || seg.index >= node.length) return;
    collectBody(node[seg.index], segments, i + 1, [...prefix, { index: seg.index }], st, depth + 1);
    return;
  }
  // wildcard: expand the whole array. NOT truncated — silent truncation would over-collapse arrays
  // that differ only past the cut. Instead the step/value budget above trips `overflow` → content-hash.
  if (!Array.isArray(node)) return;
  for (let idx = 0; idx < node.length; idx++) {
    if (st.overflow) return;
    collectBody(node[idx], segments, i + 1, [...prefix, { index: idx }], st, depth + 1);
  }
}

/** True if a concrete extracted leaf matches an exclude pattern (exclude `[*]` matches any index). */
function matchesExclude(
  leaf: Extracted,
  pattern: { root: string; segments: readonly PathSegment[] },
): boolean {
  if (leaf.root !== pattern.root) return false;
  if (leaf.segments.length !== pattern.segments.length) return false;
  for (let i = 0; i < leaf.segments.length; i++) {
    const a = leaf.segments[i];
    const p = pattern.segments[i];
    if (a === undefined || p === undefined) return false;
    if ("wildcard" in p) {
      if (!("index" in a)) return false;
    } else if ("index" in p) {
      if (!("index" in a) || a.index !== p.index) return false;
    } else {
      if (!("key" in a) || a.key !== p.key) return false;
    }
  }
  return true;
}

function label(e: Extracted): string {
  let s: string = e.root;
  for (const seg of e.segments) s += "index" in seg ? `[${seg.index}]` : `.${seg.key}`;
  return s;
}

function frame(pairs: readonly Extracted[]): Uint8Array {
  // Length-prefixed framing so no label/value concatenation can be forged to collide.
  const parts: string[] = [];
  for (const e of pairs) {
    const l = label(e);
    let tag: string;
    let v: string;
    if (typeof e.value === "string") {
      tag = "s";
      // NOT truncated: the body-size gate already bounds every extracted value (a substring of a
      // <=64KiB body), and truncating would over-collapse two distinct values sharing a long prefix.
      v = e.value;
    } else if (typeof e.value === "number") {
      tag = "n";
      // Numbers follow JSON/IEEE-754 semantics: two integer ids above 2^53 can already be
      // indistinguishable after JSON.parse. Operators keying on such ids should select the STRING id
      // field (providers virtually always send ids as strings); documented in ADR-0104.
      v = String(e.value);
    } else if (typeof e.value === "boolean") {
      tag = "b";
      v = e.value ? "1" : "0";
    } else {
      tag = "z";
      v = "";
    }
    parts.push(`${l.length}:${l}${tag}${v.length}:${v}`);
  }
  return utf8Encoder.encode(parts.join(""));
}

/**
 * Evaluate configured include/exclude field paths over one request. `include`/`exclude` are the
 * pre-validated path strings from the endpoint's dedup config.
 */
export function evaluateFields(
  rawBody: Uint8Array,
  headers: Headers,
  url: URL,
  include: readonly string[],
  exclude: readonly string[],
): FieldEval {
  // Parse the (already config-validated) paths; a parse miss here is impossible in practice but we
  // fail safe to `unique` rather than trust it.
  const inc: { root: string; segments: readonly PathSegment[] }[] = [];
  for (const p of include) {
    const r = parseFieldPath(p);
    if (!r.ok) return { kind: "unique" };
    inc.push(r.parsed);
  }
  const exc: { root: string; segments: readonly PathSegment[] }[] = [];
  for (const p of exclude) {
    const r = parseFieldPath(p);
    if (!r.ok) return { kind: "unique" };
    exc.push(r.parsed);
  }

  const usesBody = inc.some((p) => p.root === "body") || exc.some((p) => p.root === "body");
  let parsedBody: unknown;
  if (usesBody) {
    if (rawBody.byteLength > MAX_FIELD_BODY_BYTES) return { kind: "content" };
    try {
      parsedBody = JSON.parse(utf8Decoder.decode(rawBody));
    } catch {
      return { kind: "unique" }; // configured body field is unresolvable → distinct event
    }
  }

  const st: CollectState = { out: [], steps: 0, overflow: false };
  for (const path of inc) {
    const before = st.out.length;
    switch (path.root) {
      case "path":
        st.out.push({ root: "path", segments: [], value: url.pathname });
        break;
      case "headers": {
        const name = (path.segments[0] as { key: string }).key;
        const v = findHeader(headers, name);
        if (v !== undefined) st.out.push({ root: "headers", segments: [{ key: name }], value: v });
        break;
      }
      case "query": {
        const name = (path.segments[0] as { key: string }).key;
        for (const v of url.searchParams.getAll(name))
          st.out.push({ root: "query", segments: [{ key: name }], value: v });
        break;
      }
      case "body":
        collectBody(parsedBody, path.segments, 0, [], st, 0);
        break;
    }
    if (st.overflow || st.out.length > MAX_EXTRACTED_VALUES) return { kind: "content" };
    // A configured include path that resolved to NOTHING → fail safe (never collapse on a subset).
    if (st.out.length === before) return { kind: "unique" };
  }
  const collected = st.out;

  const kept =
    exc.length === 0 ? collected : collected.filter((e) => !exc.some((p) => matchesExclude(e, p)));
  if (kept.length === 0) return { kind: "unique" }; // everything excluded → nothing to key on

  return { kind: "key", bytes: frame(kept) };
}
