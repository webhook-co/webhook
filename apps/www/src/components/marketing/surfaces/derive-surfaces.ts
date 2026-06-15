/**
 * Projects one streamed webhook event into how it looks across the four surfaces — MCP, CLI, API, and
 * the web app. This is the data behind the inspector's "one event, four surfaces" companion: the same
 * `StreamRow` rendered four ways, so parity (every capability reachable identically) becomes visible.
 *
 * Everything here is a **pure, deterministic** function of the row — `eventId` and the timestamp are
 * hashed from `row.id`, never `Date.now`/`Math.random` — so the static export's server HTML and the
 * first client render stay byte-identical. Because the surfaces derive from the *selected* row, the
 * provider variety already in the stream pool flows in for free (no hardcoded example), and a failed
 * signature renders as failed across all four surfaces.
 */

import { FAIL_REASON_LABEL, type StreamRow } from "@/components/marketing/inspector/stream-data";

export type SurfaceId = "mcp" | "cli" | "api" | "web";

/** Display order, MCP first (the platform is AI-native first). */
export const SURFACE_ORDER: readonly SurfaceId[] = ["mcp", "cli", "api", "web"];

/** A tinted run of monospace text. Maps to the terminal's syntax tokens when rendered. */
export type Tone = "dim" | "mut" | "ok" | "info" | "danger";
export interface Segment {
  text: string;
  tone?: Tone;
}
export type SurfaceLine = Segment[];

export interface SurfaceView {
  id: SurfaceId;
  /** Short tab/label name. */
  label: string;
  /** Terminal chrome title + meta. */
  title: string;
  meta: string;
  lines: SurfaceLine[];
}

// ── deterministic helpers (no time, no randomness) ──────────────────────────
function hash(input: string): number {
  // FNV-1a, 32-bit.
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

/** A stable, plausible `evt_…` id derived from the row id. Same row → same id, always. */
export function eventId(row: StreamRow): string {
  return `evt_${hash(row.id).toString(36).padStart(7, "0").slice(0, 7)}`;
}

/** A stable HH:MM:SS label derived from the row id — illustrative, not the wall clock. */
export function timeLabel(row: StreamRow): string {
  const h = hash(row.id);
  return `14:${pad2(h % 60)}:${pad2((h >>> 8) % 60)}`;
}

interface Sig {
  ok: boolean;
  /** Full label, e.g. "✓ verified" or "✕ failed — timestamp too old". */
  full: Segment;
  /** Compact label, e.g. "✓ verified" / "✕ failed". */
  short: Segment;
  httpStatus: number;
}

function sig(row: StreamRow): Sig {
  if (row.status.ok) {
    return {
      ok: true,
      full: { text: "✓ verified", tone: "ok" },
      short: { text: "✓ verified", tone: "ok" },
      httpStatus: 200,
    };
  }
  const reason = FAIL_REASON_LABEL[row.status.reason];
  return {
    ok: false,
    full: { text: `✕ failed — ${reason}`, tone: "danger" },
    short: { text: "✕ failed", tone: "danger" },
    httpStatus: 400,
  };
}

// ── the four projections ────────────────────────────────────────────────────
function mcpView(row: StreamRow): SurfaceView {
  const s = sig(row);
  const lines: SurfaceLine[] = [
    [
      { text: "→ ", tone: "dim" },
      { text: "events.get" },
      { text: `  { id: "${eventId(row)}" }`, tone: "mut" },
    ],
    [{ text: "  " }, { text: row.provider, tone: "mut" }, { text: " · " }, { text: row.event }],
    [{ text: "  signature  " }, s.full],
    s.ok
      ? [
          { text: "  → ", tone: "info" },
          { text: "agent event" },
          { text: "   tools: replay, verify", tone: "dim" },
        ]
      : [{ text: "  ✕ not emitted — signature failed", tone: "danger" }],
  ];
  return { id: "mcp", label: "MCP", title: "mcp.webhook.co", meta: "tool call", lines };
}

function cliView(row: StreamRow): SurfaceView {
  const s = sig(row);
  const lines: SurfaceLine[] = [
    [{ text: "$ ", tone: "dim" }, { text: "wbhk listen" }],
    [{ text: "→ forwarding to localhost:3000", tone: "mut" }],
    [],
    [
      { text: timeLabel(row), tone: "dim" },
      { text: `  ${row.provider}  ${row.event}  ` },
      s.short,
      { text: "  → ", tone: "dim" },
      { text: String(s.httpStatus), tone: s.ok ? "dim" : "danger" },
    ],
  ];
  return { id: "cli", label: "CLI", title: "wbhk — zsh", meta: "~/app", lines };
}

function apiView(row: StreamRow): SurfaceView {
  const s = sig(row);
  const lines: SurfaceLine[] = [
    [
      { text: "$ ", tone: "dim" },
      { text: 'curl …/v1/events -H "Bearer $WBHK_TOKEN"', tone: "mut" },
    ],
    [],
    [{ text: "{ " }, { text: `"id": "${eventId(row)}",` }],
    [{ text: `  "provider": "${row.provider}", "event": "${row.event}",` }],
    [
      { text: '  "verified": ' },
      { text: s.ok ? "true" : "false", tone: s.ok ? "info" : "danger" },
      { text: " }" },
    ],
  ];
  return { id: "api", label: "API", title: "api.webhook.co", meta: "GET /v1/events", lines };
}

function webView(row: StreamRow): SurfaceView {
  const s = sig(row);
  const lines: SurfaceLine[] = [
    [{ text: "provider   " }, { text: row.provider, tone: "mut" }],
    [{ text: "event      " }, { text: row.event, tone: "mut" }],
    [{ text: "signature  " }, s.full],
    [{ text: "status     " }, { text: `${s.httpStatus} · ${row.latencyMs}ms`, tone: "dim" }],
  ];
  return { id: "web", label: "Web app", title: "webhook.co/events", meta: eventId(row), lines };
}

const BUILDERS: Record<SurfaceId, (row: StreamRow) => SurfaceView> = {
  mcp: mcpView,
  cli: cliView,
  api: apiView,
  web: webView,
};

/** One surface view for a row. */
export function deriveSurface(row: StreamRow, id: SurfaceId): SurfaceView {
  return BUILDERS[id](row);
}

/** All four surface views for a row, in `SURFACE_ORDER`. */
export function deriveAllSurfaces(row: StreamRow): SurfaceView[] {
  return SURFACE_ORDER.map((id) => deriveSurface(row, id));
}

/** Flatten a surface view to plain text (for tests and accessible summaries). */
export function surfaceText(view: SurfaceView): string {
  return view.lines.map((line) => line.map((seg) => seg.text).join("")).join("\n");
}
