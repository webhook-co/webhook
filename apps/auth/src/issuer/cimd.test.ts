import { describe, expect, it } from "vitest";

import { isCimdClientId, isCimdRedirectAllowed } from "./dcr";

// CIMD (Client ID Metadata Documents) — the client_id is itself an https URL to a JSON metadata doc the
// client hosts. The provider fetches it and takes redirect_uris STRAIGHT FROM the document — our DCR
// redirect policy (clientRegistrationCallback) never runs on this path. Without the fence below, CIMD lets
// a client name any redirect it likes.
//
// The fence (draft-ietf-oauth-client-id-metadata-document §MAY same-origin restriction): a CIMD client's
// requested redirect_uri MUST be either an http loopback (any port) OR https SAME-ORIGIN with the client_id
// URL. That forces the authorization code to land on the SAME origin the consent screen displays — so it
// can't be redirected to a THIRD origin. (It does NOT stop consent-phishing where the attacker owns both the
// doc and the redirect on one origin — that is the consent screen's job.)
//
// The three real CIMD clients as of 2026-07-11 (metadata docs fetched LIVE) all pass this verbatim:
//   Claude Code  client_id https://claude.ai/oauth/claude-code-client-metadata  → http://localhost/callback, http://127.0.0.1/callback
//   VS Code      client_id https://vscode.dev/oauth/client-metadata.json        → http://127.0.0.1:33418/, https://vscode.dev/redirect
//   Zed          client_id https://zed.dev/oauth/client-metadata.json           → http://127.0.0.1/callback

describe("isCimdClientId", () => {
  it("recognises an https URL with a non-root path (the provider's isClientMetadataUrl rule)", () => {
    expect(isCimdClientId("https://claude.ai/oauth/claude-code-client-metadata")).toBe(true);
    expect(isCimdClientId("https://vscode.dev/oauth/client-metadata.json")).toBe(true);
    expect(isCimdClientId("https://zed.dev/oauth/client-metadata.json")).toBe(true);
  });

  it("is NOT a CIMD id for a bare opaque DCR client id, an http url, or a root-path https url", () => {
    expect(isCimdClientId("cli_wbhk")).toBe(false); // opaque DCR client
    expect(isCimdClientId("http://example.com/c.json")).toBe(false); // must be https
    expect(isCimdClientId("https://example.com")).toBe(false); // root path only
    expect(isCimdClientId("https://example.com/")).toBe(false); // root path only
    expect(isCimdClientId("not a url")).toBe(false);
  });
});

describe("isCimdRedirectAllowed — the same-origin-or-loopback fence", () => {
  const claudeCode = "https://claude.ai/oauth/claude-code-client-metadata";
  const vscode = "https://vscode.dev/oauth/client-metadata.json";
  const zed = "https://zed.dev/oauth/client-metadata.json";

  it("accepts every real CIMD client's live redirect_uris verbatim (zero coverage cost)", () => {
    expect(isCimdRedirectAllowed(claudeCode, "http://localhost/callback")).toBe(true);
    expect(isCimdRedirectAllowed(claudeCode, "http://127.0.0.1/callback")).toBe(true);
    expect(isCimdRedirectAllowed(vscode, "http://127.0.0.1:33418/")).toBe(true);
    expect(isCimdRedirectAllowed(vscode, "https://vscode.dev/redirect")).toBe(true); // same-origin https
    expect(isCimdRedirectAllowed(zed, "http://127.0.0.1/callback")).toBe(true);
  });

  it("accepts an http loopback on any port/host form", () => {
    expect(isCimdRedirectAllowed(zed, "http://127.0.0.1:59123/cb")).toBe(true);
    expect(isCimdRedirectAllowed(zed, "http://[::1]:8080/cb")).toBe(true);
    expect(isCimdRedirectAllowed(zed, "http://localhost:3000/x")).toBe(true);
  });

  it("REJECTS a cross-origin https redirect — no code delivery to a third origin", () => {
    expect(isCimdRedirectAllowed("https://evil.com/c.json", "https://not-evil.com/cb")).toBe(false);
    expect(isCimdRedirectAllowed(claudeCode, "https://claude.ai.evil.com/cb")).toBe(false);
    expect(isCimdRedirectAllowed(claudeCode, "https://evil.com/cb")).toBe(false);
  });

  it("REJECTS a same-site but different-origin https redirect (exact origin only, no eTLD+1 widening)", () => {
    // A subdomain is a different origin; a different port is a different origin. vscode.dev's doc may only
    // redirect to vscode.dev:443, not cdn.vscode.dev or vscode.dev:8443.
    expect(isCimdRedirectAllowed(vscode, "https://cdn.vscode.dev/redirect")).toBe(false);
    expect(isCimdRedirectAllowed(vscode, "https://vscode.dev:8443/redirect")).toBe(false);
  });

  it("REJECTS plain http to a non-loopback host (http is only allowed for loopback)", () => {
    expect(isCimdRedirectAllowed(claudeCode, "http://claude.ai/cb")).toBe(false);
    expect(isCimdRedirectAllowed(claudeCode, "http://evil.com/cb")).toBe(false);
  });

  it("REJECTS our own origins as a CIMD redirect (no open-redirect-to-self)", () => {
    expect(isCimdRedirectAllowed("https://webhook.co/c.json", "https://webhook.co/cb")).toBe(false);
    expect(
      isCimdRedirectAllowed("https://auth.webhook.co/c.json", "https://auth.webhook.co/cb"),
    ).toBe(false);
  });

  it("REJECTS a custom scheme and a non-url redirect", () => {
    expect(isCimdRedirectAllowed(zed, "zed://callback")).toBe(false);
    expect(isCimdRedirectAllowed(zed, "not a url")).toBe(false);
  });

  it("REJECTS when the client_id itself is not a valid CIMD url (defense in depth)", () => {
    expect(isCimdRedirectAllowed("not a url", "http://127.0.0.1/cb")).toBe(false);
    expect(isCimdRedirectAllowed("http://example.com/c.json", "http://127.0.0.1/cb")).toBe(false);
  });

  it("uses parsed origins, defeating userinfo / trailing-dot confusion", () => {
    expect(isCimdRedirectAllowed(vscode, "https://vscode.dev@evil.com/redirect")).toBe(false);
    expect(
      isCimdRedirectAllowed("https://vscode.dev./oauth/c.json", "https://vscode.dev/redirect"),
    ).toBe(true); // trailing dot normalised on both sides
  });
});
