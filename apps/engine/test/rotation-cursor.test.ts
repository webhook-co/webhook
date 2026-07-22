import { describe, expect, it } from "vitest";

import {
  parseRotationCursor,
  persistRotationCursor,
  type RotationCursorStore,
} from "../src/rotation-cursor";

// The cron rotations page through orgs and resume from a stored cursor. The failure mode this file exists
// for is silent: a cron that resumes past the end of its list reconciles NOTHING, reports zero drift, and
// is indistinguishable from a clean run. So both halves — how a stored value is interpreted, and how the
// wrap is written — are pinned here rather than left to the call site.

/** Records every KV write so the test can assert put-vs-delete, not just "something happened". */
function recordingStore(): { store: RotationCursorStore; ops: string[] } {
  const ops: string[] = [];
  return {
    ops,
    store: {
      put: async (key: string, value: string) => void ops.push(`put ${key}=${value}`),
      delete: async (key: string) => void ops.push(`delete ${key}`),
    },
  };
}

const UUID = "b24ceefe-f1a1-45bc-8e84-f459003cf6fa";

describe("parseRotationCursor", () => {
  it("passes a canonical UUID through unchanged", () => {
    expect(parseRotationCursor(UUID)).toEqual({ cursor: UUID, malformed: false });
  });

  it("treats absent and EMPTY as a clean start, not as a malformed value", () => {
    // The empty string is the shape a cleared KV key can take, and it is also the exact value that used to
    // reach SQL and fail with `invalid input syntax for type uuid` — a cron that errored every tick until
    // the key was cleared by hand. It is a normal start, and must not be alarmed on.
    for (const raw of [null, undefined, ""]) {
      expect(parseRotationCursor(raw)).toEqual({ cursor: null, malformed: false });
    }
  });

  it("restarts the rotation on anything that is not a UUID, and says so", () => {
    // Restarting is safe (a read-only pass re-checks work already checked). Doing it SILENTLY is not: a
    // cursor that keeps arriving corrupted means the rotation never advances, while coverage counters
    // still read clean.
    for (const raw of [
      "not-a-uuid",
      "B24CEEFE-F1A1-45BC-8E84-F459003CF6FA", // uppercase is not the canonical form org ids take
      `${UUID} `, // trailing space — a hand-edited key
      `${UUID}x`,
      "0",
      "null",
      '{"cursor":"x"}', // a future shape change that a stale reader must not misread
    ]) {
      expect(parseRotationCursor(raw)).toEqual({ cursor: null, malformed: true });
    }
  });

  it("accepts the all-zero UUID — it is a valid resume point, not a sentinel to reject", () => {
    const zero = "00000000-0000-0000-0000-000000000000";
    expect(parseRotationCursor(zero)).toEqual({ cursor: zero, malformed: false });
  });
});

describe("persistRotationCursor", () => {
  it("writes the resume point when the pass has more to do", async () => {
    const { store, ops } = recordingStore();

    await persistRotationCursor(store, "k", UUID);

    expect(ops).toEqual([`put k=${UUID}`]);
  });

  it("DELETES the key on a wrap, rather than writing a sentinel", async () => {
    // The next read must start from the beginning. Writing a value here would leave something every future
    // reader has to interpret, and a reader that got it wrong would resume past the end of the list and
    // reconcile nothing — the silent failure this whole module guards against.
    const { store, ops } = recordingStore();

    await persistRotationCursor(store, "k", null);

    expect(ops).toEqual(["delete k"]);
  });
});
