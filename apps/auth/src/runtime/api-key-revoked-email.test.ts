import { describe, expect, it } from "vitest";

import { renderApiKeyRevokedEmail } from "./api-key-revoked-email";

const ctx = {
  keyName: "ci-deploy",
  keyStart: "whk_AbC1234",
  source: "github_secret_scanning",
} as const;

describe("renderApiKeyRevokedEmail", () => {
  it("names the key and says plainly that it was revoked", () => {
    const email = renderApiKeyRevokedEmail(ctx);
    expect(email.subject).toMatch(/revoked/i);
    expect(email.text).toContain("ci-deploy");
    expect(email.html).toContain("ci-deploy");
  });

  it("says WHERE the leak was found so the owner can clean up the source", () => {
    const email = renderApiKeyRevokedEmail(ctx);
    expect(email.text).toMatch(/public (repository|repo)/i);
    expect(email.text).toMatch(/GitHub/);
  });

  it("tells the owner what to do next and links the remediation docs", () => {
    const email = renderApiKeyRevokedEmail(ctx);
    expect(email.text).toContain("https://docs.webhook.co/leaked-api-key");
    expect(email.html).toContain("https://docs.webhook.co/leaked-api-key");
  });

  it("escapes a hostile key name into the HTML (names are user-controlled)", () => {
    const email = renderApiKeyRevokedEmail({
      ...ctx,
      keyName: `<script>alert('x')</script>`,
    });
    expect(email.html).not.toContain("<script>alert");
    expect(email.html).toContain("&lt;script&gt;");
  });

  it("escapes a hostile key name into the SUBJECT too", () => {
    const email = renderApiKeyRevokedEmail({ ...ctx, keyName: `a"b<c` });
    // The subject is a header, not HTML — it must carry no raw angle brackets we injected into markup.
    expect(email.html).not.toContain(`a"b<c`);
  });

  it("strips CR/LF from the subject — a key name must not inject email headers", () => {
    const email = renderApiKeyRevokedEmail({
      ...ctx,
      keyName: "evil\r\nBcc: attacker@example.test",
    });
    expect(email.subject).not.toMatch(/[\r\n]/);
    expect(email.subject).not.toContain("Bcc:\n");
    // The name survives, flattened onto one line — we sanitize, we don't silently drop it.
    expect(email.subject).toContain("evil Bcc: attacker@example.test");
  });

  it("strips unicode line separators and other control chars from the subject", () => {
    const email = renderApiKeyRevokedEmail({ ...ctx, keyName: "a\u2028b\u2029c\u0000d" });
    // eslint-disable-next-line no-control-regex -- asserting control chars are stripped
    expect(email.subject).not.toMatch(/[\u0000-\u001f\u007f\u2028\u2029]/);
  });

  it("bounds a runaway key name in the SUBJECT but keeps it whole in the BODY", () => {
    const long = "x".repeat(500);
    const email = renderApiKeyRevokedEmail({ ...ctx, keyName: long });
    expect(email.subject.length).toBeLessThan(200); // the subject is a header, so it is capped
    expect(email.text).toContain(long); // ...but the body must not silently truncate the owner's name
    expect(email.html).toContain(long);
  });

  it("does not throw on a malformed context (jsonb read back from the DB)", () => {
    // The drain claims an intent BEFORE rendering it, so a throw here would lose the alert entirely.
    const bad = { source: "github_secret_scanning" } as unknown as Parameters<
      typeof renderApiKeyRevokedEmail
    >[0];
    expect(() => renderApiKeyRevokedEmail(bad)).not.toThrow();
    expect(renderApiKeyRevokedEmail(bad).subject).toMatch(/revoked/i);
  });

  it("treats a whitespace-only name as unnamed (no empty quotes in the subject)", () => {
    const email = renderApiKeyRevokedEmail({ ...ctx, keyName: "   \n  " });
    expect(email.subject).toBe("One of your API keys was leaked and has been revoked");
    expect(email.subject).not.toContain('""');
  });

  it("renders a usable email when the key was never named", () => {
    const email = renderApiKeyRevokedEmail({ ...ctx, keyName: "" });
    expect(email.subject).toMatch(/revoked/i);
    expect(email.text.length).toBeGreaterThan(0);
    expect(email.html).toContain("whk_AbC1234");
  });

  it("carries the non-secret key start, and nothing that could be a full key", () => {
    const email = renderApiKeyRevokedEmail(ctx);
    expect(email.text).toContain("whk_AbC1234");
    // A real key is 53 chars; the start is a short display handle. Assert nothing key-shaped appears.
    expect(email.text).not.toMatch(/whk_[0-9A-Za-z]{49}/);
    expect(email.html).not.toMatch(/whk_[0-9A-Za-z]{49}/);
  });

  it("produces subject, html and text (the RenderedEmail contract)", () => {
    const email = renderApiKeyRevokedEmail(ctx);
    expect(Object.keys(email).sort()).toEqual(["html", "subject", "text"]);
    expect(email.html).toContain("<!DOCTYPE html>");
  });
});
