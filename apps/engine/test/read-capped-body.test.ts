import { describe, expect, it } from "vitest";

import { readCappedBody } from "../src/ingest";

// readCappedBody is the body-cap hardening (review finding C1): bound the read AS IT STREAMS and
// abort the moment the cap is exceeded, rather than buffering an arbitrarily large body and only
// then checking its size. Over-cap input must cancel the stream early (not drain every chunk).

function trackedStream(chunks: Uint8Array[]): {
  stream: ReadableStream<Uint8Array>;
  pulls: () => number;
  cancelled: () => boolean;
} {
  let pulls = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (pulls < chunks.length) {
          controller.enqueue(chunks[pulls]!);
          pulls += 1;
        } else {
          controller.close();
        }
      },
      cancel() {
        cancelled = true;
      },
    },
    // highWaterMark 0: no prefetch, so the source is pulled once per read() — pulls() then exactly
    // counts the chunks we actually consumed (proving the chunk past the cap is never read).
    new CountQueuingStrategy({ highWaterMark: 0 }),
  );
  return { stream, pulls: () => pulls, cancelled: () => cancelled };
}

describe("readCappedBody", () => {
  it("returns the exact concatenated bytes for a body within the cap", async () => {
    const t = trackedStream([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])]);
    const out = await readCappedBody(t.stream, 16);
    expect(out && [...out]).toEqual([1, 2, 3, 4, 5]);
    expect(t.cancelled()).toBe(false);
  });

  it("returns an empty array for a null body (no stream to read)", async () => {
    const out = await readCappedBody(null, 16);
    expect(out && [...out]).toEqual([]);
  });

  it("accepts a body exactly at the cap", async () => {
    const t = trackedStream([new Uint8Array(8), new Uint8Array(8)]);
    const out = await readCappedBody(t.stream, 16);
    expect(out?.byteLength).toBe(16);
  });

  it("returns null AND cancels the stream early once the cap is exceeded (no full buffering)", async () => {
    // Three 10-byte chunks, cap 15: chunk 2 pushes the total to 20 (> 15) -> abort. The third
    // chunk must never be pulled, proving we don't buffer the whole body before rejecting.
    const t = trackedStream([new Uint8Array(10), new Uint8Array(10), new Uint8Array(10)]);
    const out = await readCappedBody(t.stream, 15);
    expect(out).toBeNull();
    expect(t.cancelled()).toBe(true);
    expect(t.pulls()).toBe(2); // stopped at the chunk that breached the cap, never read chunk 3
  });
});
