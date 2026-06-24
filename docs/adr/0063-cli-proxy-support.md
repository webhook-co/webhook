# ADR 0063 — CLI HTTP(S) proxy support (distribution DIST-2)

- status: accepted (distribution Phase 1, DIST-2).
- date: 2026-06-24
- scope: new `packages/cli/src/proxy.ts` (`resolveProxy`) + tests; `packages/cli/src/io.ts`
  (`connectWebSocket` routes the tunnel through an `HttpsProxyAgent`); new dep `https-proxy-agent`.
- relates: `internal/build-plans/cli-distribution.md` (DIST-2). The listen tunnel (ADR-0014) + the api
  client.
- review severity: low-medium (network egress path; a new bundled dep). `/code-review` + `/security-review`.

## context

Corporate / restricted networks route all egress through an HTTP(S) proxy advertised via the de-facto
`HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` env vars. The CLI has two egress paths — the api-client `fetch`
(reads / replay) and the `wbhk listen` WebSocket tunnel — and neither honored a proxy.

The two runtimes differ:
- **The bun-compiled binary (primary channel):** Bun's `fetch` honors `HTTP(S)_PROXY` / `NO_PROXY`
  **natively** — so the api path is covered for free.
- **The npm / Node path:** Node 24's global `fetch` honors the env proxy when run with `NODE_USE_ENV_PROXY=1`
  (24.5+); there is **no** runtime API to code-enable it (`http.setGlobalProxyFromEnv` is absent in our
  Node 24.12 + Bun), so this stays a documented env flag.
- **`ws` (the tunnel), BOTH runtimes:** never auto-proxies — it opens a raw socket. This is the real gap.

## decision

1. **`resolveProxy(targetUrl, env)` — a pure, tested env resolver.** Mirrors curl/wget: `HTTPS_PROXY` for
   https+wss, `HTTP_PROXY` for http+ws, `ALL_PROXY` fallback; `NO_PROXY` (`*` or a comma-list of dot-bounded
   host suffixes) excludes a host; env names matched case-insensitively. Ports/CIDRs in `NO_PROXY` aren't
   interpreted (host-suffix match — the common case). Env is injected so it's unit-tested with no globals.

2. **The tunnel routes through an `HttpsProxyAgent`.** `io.ts connectWebSocket` calls `resolveProxy(url,
   process.env)` and, when a proxy applies, passes a `https-proxy-agent` as the `ws` upgrade agent (CONNECT
   tunnel — works for `wss://` on both Node and the Bun binary). Verified it bundles under `bun --compile`
   (188 modules; binary runs). The wiring is the coverage-excluded io seam; the decision logic is `resolveProxy`.

3. **`fetch` proxy is left to the runtime.** The binary gets it natively (Bun); the npm/Node path documents
   `NODE_USE_ENV_PROXY=1`. No fetch-side code + no undici dependency in the binary (Bun's fetch ignores
   undici dispatchers anyway). So a corporate-proxy user on the **binary** is fully covered (fetch native +
   tunnel agent); on **npm** they add the one env flag for fetch (the tunnel agent already works).

## consequences

- `HTTPS_PROXY=… wbhk listen <ep>` now connects the tunnel through the proxy; `HTTPS_PROXY=… wbhk events
  list` works on the binary natively (npm: `+ NODE_USE_ENV_PROXY=1`). `NO_PROXY` is honored for both.
- One small, standard, widely-used dep (`https-proxy-agent`) — bundles cleanly; the only new egress-path code
  is the env resolver (tested) + the agent attachment (io seam).
- A `doctor` "proxy: <detected>" line is a sensible follow-up (surface the resolved proxy per target) — not
  in this slice.

## alternatives considered

- **An undici `EnvHttpProxyAgent` global dispatcher for fetch.** Rejected — Node-only (Bun's fetch ignores
  undici dispatchers), would bundle undici into the Bun binary for no benefit there, and the binary is
  already native. The npm flag (`NODE_USE_ENV_PROXY`) is simpler.
- **`proxy-from-env` for the env logic.** Rejected — it reads `process.env` globally (awkward to unit-test);
  a ~20-line injected `resolveProxy` is testable + dep-free for that part.
- **Skip tunnel proxy (fetch only).** Rejected — a corp user needs `wbhk listen` to work too; `ws` is the
  genuine gap.
