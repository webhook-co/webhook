import { VerificationFailureSchema } from "@webhook-co/webhooks-spec";
import { describe, expect, it } from "vitest";

import { EVENT_POOL, FAIL_REASON_LABEL, SEED_ROWS, type SigFailReason } from "./stream-data";

/**
 * The inspector's stream is a staged demo — but every string in it is a string the product really
 * produces. The failure reasons it shows are the codes from the shipped `VerificationFailureSchema`,
 * not lowercase lookalikes invented for the page.
 *
 * Test-only import (`@webhook-co/webhooks-spec` is a devDependency of apps/www): the schema never
 * enters the static-export bundle, it just keeps the demo honest.
 */

const REAL_CODES = new Set(
  VerificationFailureSchema.options.map((option) => option.shape.code.value as string),
);

/** Every failure reason the stream can actually paint (the pool + the server-rendered seed frame). */
const SHOWN: readonly SigFailReason[] = [...EVENT_POOL, ...SEED_ROWS].flatMap((row) =>
  row.status.ok ? [] : [row.status.reason],
);

describe("the inspector stream's failure reasons", () => {
  it("reads the real codes off the schema (this test is not vacuous)", () => {
    expect(REAL_CODES.size).toBe(11);
    expect(REAL_CODES.has("RAW_BODY_MODIFIED")).toBe(true);
    expect(REAL_CODES.has("raw_body_modified")).toBe(false);
  });

  it("only shows reasons the verification union can actually emit", () => {
    expect(SHOWN.length).toBeGreaterThan(0);
    for (const reason of SHOWN) {
      expect(REAL_CODES, `the stream shows ${reason}, which no adapter can emit`).toContain(reason);
    }
  });

  it("labels only real codes, and labels every code it shows", () => {
    const labelled = Object.keys(FAIL_REASON_LABEL);
    expect(labelled.length).toBeGreaterThan(0);
    for (const code of labelled) {
      expect(REAL_CODES, `${code} has a label but is not a real failure code`).toContain(code);
    }
    for (const reason of SHOWN) {
      expect(FAIL_REASON_LABEL[reason]).toBeTruthy();
    }
  });
});
