import { describe, expect, it } from "vitest";

import { redactUriCredentials, safeErrorMessage } from "./redact";

describe("redactUriCredentials", () => {
  it("removes the password from a Hyperdrive connection string, keeping what makes it diagnosable", () => {
    expect(
      redactUriCredentials("connection to postgres://webhook_sweeper:S3cr3t@db.host/neondb failed"),
    ).toBe("connection to postgres://webhook_sweeper:***@db.host/neondb failed");
  });

  it("redacts every occurrence, not just the first", () => {
    const out = redactUriCredentials(
      "postgres://a:one@h1/db and postgres://b:two@h2/db both failed",
    );
    expect(out).not.toContain("one");
    expect(out).not.toContain("two");
    expect(out).toBe("postgres://a:***@h1/db and postgres://b:***@h2/db both failed");
  });

  it("covers non-postgres schemes too", () => {
    expect(redactUriCredentials("https://user:token@api.example/x")).toBe(
      "https://user:***@api.example/x",
    );
  });

  it("leaves text without embedded credentials untouched", () => {
    for (const text of [
      "deadlock detected",
      "connect ECONNREFUSED 10.0.0.1:5432",
      "postgres://db.host/neondb", // no credential section
      "",
    ]) {
      expect(redactUriCredentials(text)).toBe(text);
    }
  });

  it("does not mistake a bare colon for a credential boundary", () => {
    expect(redactUriCredentials("timeout after 30s: query cancelled")).toBe(
      "timeout after 30s: query cancelled",
    );
  });
});

describe("safeErrorMessage", () => {
  it("redacts an Error's message", () => {
    expect(safeErrorMessage(new Error("bad postgres://r:pw@h/db"))).toBe(
      "bad postgres://r:***@h/db",
    );
  });

  it("handles a non-Error throw without itself throwing", () => {
    expect(safeErrorMessage("postgres://r:pw@h/db")).toBe("postgres://r:***@h/db");
    expect(safeErrorMessage(undefined)).toBe("undefined");
    expect(safeErrorMessage(null)).toBe("null");
    expect(safeErrorMessage({ toString: () => "postgres://r:pw@h/db" })).toBe(
      "postgres://r:***@h/db",
    );
  });
});
