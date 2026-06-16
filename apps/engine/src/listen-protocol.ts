import { EventSummarySchema } from "@webhook-co/shared";
import { z } from "zod";

// The `wbhk listen` tunnel wire protocol (Slice 11b, ADR-0014): JSON text frames over the WebSocket.
// Summaries-only (the events.tail element, never a payload body), single-lane (everything delivered
// at/below the gapless watermark), at-least-once (the consumer dedups by cursor/id). Engine-local —
// the CLI (11c) re-declares the tiny client-side view it needs rather than importing this module.

/** server→client, first frame after the upgrade: announces the session id + the watermark lag. */
export const ReadyFrameSchema = z.object({
  type: z.literal("ready"),
  sessionId: z.string(),
  watermarkDeltaMs: z.number().int().nonnegative(),
});

/** server→client: one arrived event — the events.tail summary + its opaque resume cursor. */
export const EventFrameSchema = z.object({
  type: z.literal("event"),
  summary: EventSummarySchema,
  cursor: z.string(),
});

/** server→client: a recoverable notice (e.g. a degraded poll); not a fatal close on its own. */
export const ErrorFrameSchema = z.object({
  type: z.literal("error"),
  code: z.string(),
  message: z.string(),
});

/** client→server: acknowledges processing up to `cursor` (advisory in the inspection tail). */
export const AckFrameSchema = z.object({
  type: z.literal("ack"),
  cursor: z.string(),
});

export const ServerFrameSchema = z.discriminatedUnion("type", [
  ReadyFrameSchema,
  EventFrameSchema,
  ErrorFrameSchema,
]);
/** The only frame type the server accepts from a client today. */
export const ClientFrameSchema = z.discriminatedUnion("type", [AckFrameSchema]);

export type ReadyFrame = z.infer<typeof ReadyFrameSchema>;
export type EventFrame = z.infer<typeof EventFrameSchema>;
export type ErrorFrame = z.infer<typeof ErrorFrameSchema>;
export type AckFrame = z.infer<typeof AckFrameSchema>;
export type ServerFrame = z.infer<typeof ServerFrameSchema>;
export type ClientFrame = z.infer<typeof ClientFrameSchema>;

/**
 * Parse + validate an inbound client frame (untrusted WebSocket input). Returns `null` on ANY
 * malformed input — bad JSON, unknown `type`, missing/ill-typed fields — so the DO can answer with
 * an `error` frame instead of throwing inside `webSocketMessage`. Accepts the `string | ArrayBuffer`
 * the runtime delivers.
 */
export function parseClientFrame(raw: string | ArrayBuffer): ClientFrame | null {
  const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const result = ClientFrameSchema.safeParse(json);
  return result.success ? result.data : null;
}

/** Serialize a server frame to the JSON text sent over the socket (Date → ISO inside the summary). */
export function encodeServerFrame(frame: ServerFrame): string {
  return JSON.stringify(frame);
}
