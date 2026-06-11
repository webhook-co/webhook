---
name: build-mcpb
description: Package a local stdio MCP server into an installable MCPB bundle. Use only when shipping a server users install and run on their own machine (e.g. alongside the CLI tunnel), not for the Workers-hosted remote server.
---

# Build MCPB

MCPB packages a **local stdio MCP server** into a single installable bundle a user can drop into an
MCP host. Use it only when the server must run on the user's machine — the clearest case here is
tooling that rides with the CLI / tunnel client and needs local environment access. For anything
that can run server-side, prefer the **remote streamable-HTTP server on Workers** (see
`build-mcp-server`); don't package something as MCPB just to avoid hosting it.

## When MCPB is the right call

- The server needs the user's local filesystem, processes, or network position (e.g. replay-to-
  localhost tooling) that a remote Worker can't reach.
- You want one-step install for a stdio server instead of asking users to clone and wire up a runtime.

If neither is true, it belongs on Workers as a remote server.

## Packaging checklist

- [ ] The server runs over **stdio** and starts cleanly with no manual setup beyond the bundle.
- [ ] The manifest declares name, version, entry point, and the inputs/secrets it expects — with
      **clear placeholders, never real tokens or account/zone IDs**.
- [ ] Secrets are requested at install/runtime and read from the environment; nothing sensitive is
      baked into the bundle.
- [ ] Tool contracts and types match the other surfaces (`shared/`); the bundle is a packaging of an
      existing capability, not a divergent one.
- [ ] Versioning + a smoke test: the bundle installs and the tools respond on a clean machine.

## Guardrails

- MCP/AI-native parity: a locally-bundled capability still exists on CLI/API/web/MCP at parity.
- Standard-Webhooks-native signing/verification; no hand-rolled schemes shipped in the bundle.
- Private-by-default and public-safe: no secrets, account/zone IDs, or pricing details in the manifest
  or bundled code.
- A local server is still subject to the same validation and redaction rules — never log full payloads
  or PII/PHI.

## Progressive disclosure

Keep the manifest template, signing/distribution steps, and a clean-machine install drill in `references/`.
