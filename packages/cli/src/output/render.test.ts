import type { Endpoint, Event, EventSummary } from "@webhook-co/shared";
import { describe, expect, it } from "vitest";

import type { AuditVerifyResult } from "../api-client.js";
import { stripAnsi } from "./color.js";
import {
  renderAuditResult,
  renderEndpoint,
  renderEndpointsTable,
  renderEvent,
  renderEventsTable,
} from "./render.js";

const endpoint: Endpoint = {
  id: "ep_1",
  orgId: "org_1",
  name: "orders-prod",
  paused: false,
  createdAt: new Date("2026-05-01T00:00:00.000Z"),
};

const eventSummary: EventSummary = {
  id: "ev_1",
  orgId: "org_1",
  endpointId: "ep_1",
  receivedAt: new Date("2026-05-02T14:23:07.000Z"),
  provider: null,
  dedupKey: "dk_1",
  dedupStrategy: "sw_webhook_id",
  verified: false,
};

const event: Event = {
  ...eventSummary,
  provider: "stripe",
  verified: true,
  payloadR2Key: "r2/k",
  payloadBytes: 321,
  contentType: "application/json",
  method: "POST",
  headers: [
    ["content-type", "application/json"],
    ["x-sig", "abc"],
  ],
  providerEventId: null,
  externalId: null,
  verification: { ok: true, keyId: "key_1", scheme: "stripe" },
};

describe("renderEndpointsTable", () => {
  it("renders UPPERCASE headers + a status WORD (active/paused), full id, date-only created", () => {
    const out = renderEndpointsTable([endpoint], false);
    expect(out).toContain("NAME");
    expect(out).toContain("STATUS");
    expect(out).toContain("orders-prod");
    expect(out).toContain("active");
    expect(out).toContain("ep_1");
    expect(out).toContain("2026-05-01");
    expect(out).not.toContain("2026-05-01T"); // date only, not a full timestamp
  });

  it("shows `paused` for a paused endpoint", () => {
    const out = renderEndpointsTable([{ ...endpoint, paused: true }], false);
    expect(out).toContain("paused");
    expect(out).not.toContain("active");
  });

  it("color-styles the status word when enabled, leaving the same visible text", () => {
    const out = renderEndpointsTable([endpoint], true);
    expect(out).toContain(String.fromCharCode(27)); // an ANSI escape was emitted
    expect(stripAnsi(out)).toContain("active");
  });
});

describe("renderEventsTable", () => {
  it("renders an em dash for a null provider and the verified word", () => {
    const out = renderEventsTable([eventSummary], false);
    expect(out).toContain("RECEIVED");
    expect(out).toContain("PROVIDER");
    expect(out).toContain("—");
    expect(out).toContain("unverified");
    expect(out).toContain("ev_1");
  });

  it("renders the distinct 'authenticated' word for a Tier-4 token/basic event (not 'verified')", () => {
    const out = renderEventsTable(
      [{ ...eventSummary, verified: true, verificationState: "authenticated" }],
      false,
    );
    expect(out).toContain("authenticated");
    expect(out).not.toMatch(/\bverified\b/); // the green crypto word must NOT be used
  });
});

describe("renderEndpoint (single record)", () => {
  it("renders an aligned key:value block", () => {
    const out = renderEndpoint(endpoint, false);
    expect(out).toContain("name:");
    expect(out).toContain("orders-prod");
    expect(out).toContain("status:");
    expect(out).toContain("active");
  });
});

describe("renderEvent (single record)", () => {
  it("summarizes verification with the signing scheme on success", () => {
    expect(renderEvent(event, false)).toContain("verified (stripe)");
  });

  it("summarizes verification with the failure code on failure", () => {
    const failed: Event = {
      ...event,
      verified: false,
      verification: { ok: false, reason: { code: "SIGNATURE_MISMATCH" } },
    };
    expect(renderEvent(failed, false)).toContain("unverified (SIGNATURE_MISMATCH)");
  });

  it("summarizes a Tier-4 token/basic result as 'authenticated' + non-cryptographic", () => {
    const authed: Event = {
      ...event,
      verification: { ok: true, keyId: "secret_0", scheme: "gitlab", authenticity: "token" },
    };
    const out = renderEvent(authed, false);
    expect(out).toContain("authenticated (gitlab");
    expect(out).toContain("non-cryptographic");
  });

  it("falls back to the bare verified word when no verification detail is stored", () => {
    const out = renderEvent({ ...event, verification: null }, false);
    expect(out).toContain("verified");
    expect(out).not.toContain("verified ("); // no annotation
  });

  it("includes the header count, size, and dedup strategy", () => {
    const out = renderEvent(event, false);
    expect(out).toContain("headers");
    expect(out).toContain("2");
    expect(out).toContain("321 bytes");
    expect(out).toContain("sw_webhook_id");
  });
});

describe("control-byte sanitization (server data can't hijack the terminal)", () => {
  const ESC = String.fromCharCode(27);

  it("strips an ANSI escape injected via an endpoint name in the table", () => {
    // color OFF, so the ONLY escape that could appear is the injected one.
    const out = renderEndpointsTable([{ ...endpoint, name: `${ESC}[31mowned${ESC}[2J` }], false);
    expect(out).not.toContain(ESC);
    expect(out).toContain("owned"); // the visible text is preserved
  });

  it("strips control bytes from a single-record block (id + name)", () => {
    const out = renderEndpoint({ ...endpoint, id: `ep${ESC}[2K1`, name: `n${ESC}[0m` }, false);
    expect(out).not.toContain(ESC);
  });

  it("strips control bytes from an event's provider/dedup/content-type fields", () => {
    const out = renderEvent(
      { ...event, dedupKey: `dk${ESC}[0m`, contentType: `text/${ESC}[1mplain` },
      false,
    );
    expect(out).not.toContain(ESC);
  });

  it("strips control bytes from the event-table id + provider", () => {
    const out = renderEventsTable([{ ...eventSummary, provider: `str${ESC}[31mipe` }], false);
    expect(out).not.toContain(ESC);
  });

  it("strips control bytes from an audit-break detail", () => {
    const broken: AuditVerifyResult = {
      ok: false,
      rowsVerified: 1,
      break: { kind: "hash_mismatch", seq: 1, detail: `evil${ESC}[31m` },
    };
    expect(renderAuditResult(broken, false)).not.toContain(ESC);
  });

  it("keeps OUR own color escapes when color is enabled (only server data is sanitized)", () => {
    // The status word is colorized by us; sanitization must not strip our legitimate ANSI.
    expect(renderEndpointsTable([endpoint], true)).toContain(ESC);
  });
});

describe("renderAuditResult", () => {
  it("reports an intact chain", () => {
    const ok: AuditVerifyResult = { ok: true, rowsVerified: 7 };
    expect(renderAuditResult(ok, false)).toContain("audit chain intact (7 rows)");
  });

  it("reports the first break with seq + kind + detail", () => {
    const broken: AuditVerifyResult = {
      ok: false,
      rowsVerified: 2,
      break: { kind: "hash_mismatch", seq: 3, detail: "row 3 hash mismatch" },
    };
    const out = renderAuditResult(broken, false);
    expect(out).toContain("BROKEN");
    expect(out).toContain("seq 3");
    expect(out).toContain("hash_mismatch");
    expect(out).toContain("row 3 hash mismatch");
  });
});
