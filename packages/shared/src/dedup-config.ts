// Per-endpoint deduplication configuration + the field-path grammar that gates which
// request locations may be used as a dedup key.
//
// SECURITY BOUNDARY: this module is the CONFIG-WRITE gate. Every field path is fully
// parsed and bounded HERE, when an operator saves an endpoint's config — never at ingest
// time on the hot path. The ingest-time evaluator (in the engine) trusts that any stored
// path already parsed within these bounds, so it can extract without re-validating grammar.
// Keeping the DSL bounded (segment/index/count caps, no unbounded constructs) is what makes
// evaluating operator-authored selectors over untrusted payloads safe on the metered path.
//
// This schema is a contract INPUT, so it MUST stay `z.toJSONSchema`-clean: no `z.coerce`,
// no `.transform`. `.refine`/`.superRefine` are validators (not transforms) and are fine.

import { z } from "zod";

/** Dedup key-selection modes. See the ADR for semantics. */
export const DEDUP_MODES = ["identifier", "content", "fields", "off"] as const;
export const DedupModeSchema = z.enum(DEDUP_MODES);
export type DedupMode = (typeof DEDUP_MODES)[number];

/** Bounds — deliberately small; over-collapse (dropping distinct events) is the failure to avoid. */
export const MAX_FIELD_PATHS = 16;
export const MAX_PATH_SEGMENTS = 8;
export const MAX_ARRAY_INDEX = 100;

/** Window bounds: 1 minute .. 7 days (comfortably exceeds known sender retry windows at the top end). */
export const MIN_DEDUP_WINDOW_SECONDS = 60;
export const MAX_DEDUP_WINDOW_SECONDS = 604_800;
export const DEFAULT_DEDUP_WINDOW_SECONDS = 86_400; // 24h — the default window a collapsing mode seeds with (dedup itself is off by default)

/**
 * Whether a raw window entry (from a UI number field) is a whole number of seconds INSIDE the accepted
 * range — so a form can reject an out-of-range value with clear feedback instead of silently clamping it to
 * a bound the operator never chose. Empty / non-numeric / fractional / out-of-range → false. Pure + total.
 */
export function isDedupWindowInRange(raw: string | number): boolean {
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (String(raw).trim() === "") return false;
  return Number.isInteger(n) && n >= MIN_DEDUP_WINDOW_SECONDS && n <= MAX_DEDUP_WINDOW_SECONDS;
}

/**
 * Coerce a raw window entry to a valid in-range integer second count — the single clamp used by every
 * surface (create dialog + detail editor) so they can't drift. Rounds, then clamps into
 * [MIN, MAX]; a blank / non-numeric entry falls back to the default. This is the LAST-RESORT normalizer —
 * a form should validate with {@link isDedupWindowInRange} first and only rely on this as the server-safe
 * floor (the server re-validates regardless).
 */
export function clampDedupWindow(raw: string | number): number {
  // A blank string coerces to 0 via Number(), not NaN — treat it (and any non-numeric entry) as "unset" →
  // the default, rather than clamping an empty field up to the minimum.
  const s = String(raw).trim();
  if (s === "") return DEFAULT_DEDUP_WINDOW_SECONDS;
  const parsed = Math.round(Number(s));
  if (!Number.isFinite(parsed)) return DEFAULT_DEDUP_WINDOW_SECONDS;
  return Math.min(MAX_DEDUP_WINDOW_SECONDS, Math.max(MIN_DEDUP_WINDOW_SECONDS, parsed));
}

export type FieldPathRoot = "headers" | "body" | "query" | "path";
const FIELD_PATH_ROOTS: readonly FieldPathRoot[] = ["headers", "body", "query", "path"];

/** One accessor step within a parsed path. */
export type PathSegment =
  { readonly key: string } | { readonly index: number } | { readonly wildcard: true };

export interface ParsedFieldPath {
  readonly root: FieldPathRoot;
  /** Accessor steps AFTER the root: [] for `path`, one key for headers/query, the dot/bracket chain for body. */
  readonly segments: readonly PathSegment[];
}

export type ParseFieldPathResult =
  | { readonly ok: true; readonly parsed: ParsedFieldPath }
  | { readonly ok: false; readonly error: string };

const err = (error: string): ParseFieldPathResult => ({ ok: false, error });

/**
 * Parse + validate one field path against the bounded grammar. Pure; total (never throws).
 * Grammar:
 *   path                          -> the request path (after the routing token)
 *   headers.<name>                -> a request header value (flat key)
 *   query.<name>                  -> a query param value (flat key)
 *   body.<seg>(.<seg>)*           -> a JSON body location; <seg> = key, key[<n>], or key[*]
 */
export function parseFieldPath(raw: string): ParseFieldPathResult {
  if (raw.length === 0) return err("empty path");
  const dot = raw.indexOf(".");
  const rootStr = dot === -1 ? raw : raw.slice(0, dot);
  const rest = dot === -1 ? "" : raw.slice(dot + 1);
  if (!FIELD_PATH_ROOTS.includes(rootStr as FieldPathRoot)) return err(`unknown root: ${rootStr}`);
  const root = rootStr as FieldPathRoot;

  if (root === "path") {
    if (raw !== "path") return err("`path` takes no sub-selectors");
    return { ok: true, parsed: { root, segments: [] } };
  }

  if (root === "headers" || root === "query") {
    if (rest.length === 0) return err(`${root} requires a name`);
    if (rest.includes("[") || rest.includes("]"))
      return err(`${root} names are flat (no [] accessors)`);
    return { ok: true, parsed: { root, segments: [{ key: rest }] } };
  }

  // root === "body": dot-separated tokens, each `key` + zero-or-more `[n]`/`[*]` accessors.
  if (rest.length === 0)
    return err("`body` requires a field selector (bare body is `content` mode)");
  const segments: PathSegment[] = [];
  for (const token of rest.split(".")) {
    const bracket = token.indexOf("[");
    const key = bracket === -1 ? token : token.slice(0, bracket);
    if (key.length === 0) return err(`empty key in segment: ${token}`);
    if (key.includes("]")) return err(`malformed segment: ${token}`);
    segments.push({ key });
    if (bracket !== -1) {
      const accessors = token.slice(bracket);
      // Each accessor must be exactly [*] or [<digits>]; concatenated with no gaps.
      const re = /\[(\*|\d+)\]/g;
      let consumed = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(accessors)) !== null) {
        if (m.index !== consumed) return err(`malformed array accessor: ${token}`);
        consumed = re.lastIndex;
        if (m[1] === "*") {
          segments.push({ wildcard: true });
        } else {
          const index = Number(m[1]);
          if (index > MAX_ARRAY_INDEX) return err(`array index > ${MAX_ARRAY_INDEX}: ${token}`);
          segments.push({ index });
        }
      }
      if (consumed !== accessors.length) return err(`malformed array accessor: ${token}`);
    }
    if (segments.length > MAX_PATH_SEGMENTS) return err(`> ${MAX_PATH_SEGMENTS} segments`);
  }
  return { ok: true, parsed: { root, segments } };
}

const FieldPathString = z
  .string()
  .min(1)
  .max(256)
  .refine((s) => parseFieldPath(s).ok, { message: "invalid dedup field path" });

const FieldSelectorSchema = z.strictObject({
  include: z.array(FieldPathString).min(1).max(MAX_FIELD_PATHS),
  exclude: z.array(FieldPathString).max(MAX_FIELD_PATHS).optional(),
});
export type FieldSelector = z.infer<typeof FieldSelectorSchema>;

/**
 * Per-endpoint dedup config. `fields` is required exactly for `fields` mode and forbidden otherwise
 * (superRefine, not `.transform`, so JSON-Schema serialization is preserved for the contract gate).
 */
export const DedupConfigSchema = z
  .strictObject({
    mode: DedupModeSchema,
    // Optional so `off` (which never collapses) needs no window — required for every OTHER mode via the
    // superRefine below. Keeps the docs/API consistent (`off` takes no windowSeconds) and prevents a
    // windowless `off` from failing validation and being silently downgraded on the cold-path read.
    windowSeconds: z
      .number()
      .int()
      .min(MIN_DEDUP_WINDOW_SECONDS)
      .max(MAX_DEDUP_WINDOW_SECONDS)
      .optional(),
    fields: FieldSelectorSchema.optional(),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.mode !== "off" && cfg.windowSeconds === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "`windowSeconds` is required for this mode",
        path: ["windowSeconds"],
      });
    }
    // `off` collapses nothing, so a window is meaningless — forbid it (not merely ignore it) so every
    // surface rejects `{ mode: "off", windowSeconds }` identically. Without this the API/MCP would
    // silently accept + store a stray window that the CLI rejects, breaking CLI/API/web/MCP parity.
    if (cfg.mode === "off" && cfg.windowSeconds !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "`windowSeconds` is not valid for off mode",
        path: ["windowSeconds"],
      });
    }
    if (cfg.mode === "fields" && !cfg.fields) {
      ctx.addIssue({
        code: "custom",
        message: "`fields` is required for fields mode",
        path: ["fields"],
      });
    }
    if (cfg.mode !== "fields" && cfg.fields) {
      ctx.addIssue({
        code: "custom",
        message: "`fields` is only valid in fields mode",
        path: ["fields"],
      });
    }
  });
export type DedupConfig = z.infer<typeof DedupConfigSchema>;
