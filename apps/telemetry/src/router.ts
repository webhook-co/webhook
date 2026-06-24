// telemetry.wbhk.my — the cookieless collector for the wbhk CLI's anonymous, opt-out usage telemetry
// (DIST-14). POST /e with the anonymous event JSON → one Analytics Engine data point. Everything is
// defensively bounded: only the known fields, capped lengths, no echo — an arbitrary/abusive body is dropped.
// Always responds 204 (the CLI ignores the response; not distinguishing valid/invalid avoids feedback to
// abusers). On the SEPARATE ingestion apex (wbhk.my): cookieless, no CORS.

export interface Env {
  readonly TELEMETRY: AnalyticsEngineDataset;
}

/** The anonymous event the CLI sends (mirrors packages/cli/src/telemetry.ts; relaxed to defensive types — we
 *  never trust the wire). */
export interface TelemetryEvent {
  readonly v: string;
  readonly os: string;
  readonly arch: string;
  readonly command: string;
  readonly outcome: string;
  readonly exit: number;
  readonly duration: string;
}

// Reject control characters in untrusted strings (no injection sink today, but keeps a future dashboard clean).
// eslint-disable-next-line no-control-regex -- intentionally matching control chars in untrusted input
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

/** A bounded, non-empty, control-char-free string field, else null. */
const str = (x: unknown, max: number): string | null =>
  typeof x === "string" && x.length > 0 && x.length <= max && !CONTROL_CHARS.test(x) ? x : null;

/** Parse + validate the event — ONLY the known fields, with bounded lengths; anything else → null (dropped).
 *  Pure, so the privacy/abuse surface is unit-tested. */
export function parseEvent(body: unknown): TelemetryEvent | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  const v = str(b.v, 32);
  const os = str(b.os, 16);
  const arch = str(b.arch, 16);
  const command = str(b.command, 64);
  const outcome = str(b.outcome, 8);
  const duration = str(b.duration, 16);
  // A real POSIX exit code (the CLI only ever sends one) — integer in 0..255; anything else is dropped.
  const exit =
    typeof b.exit === "number" && Number.isInteger(b.exit) && b.exit >= 0 && b.exit <= 255
      ? b.exit
      : null;
  if (
    v === null ||
    os === null ||
    arch === null ||
    command === null ||
    outcome === null ||
    duration === null ||
    exit === null
  ) {
    return null;
  }
  return { v, os, arch, command, outcome, exit, duration };
}

export async function handleTelemetry(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST" || new URL(request.url).pathname !== "/e") {
    return new Response(null, { status: 404 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response(null, { status: 204 }); // unparseable → drop, no feedback
  }
  const event = parseEvent(body);
  if (event !== null) {
    env.TELEMETRY.writeDataPoint({
      blobs: [event.v, event.os, event.arch, event.command, event.outcome, event.duration],
      doubles: [event.exit],
      indexes: [event.command], // group by command (AE allows one index, <=96 bytes)
    });
  }
  return new Response(null, { status: 204 });
}
