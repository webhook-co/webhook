// The header policy for forwarding a captured webhook to another host — shared by the CLI replay-to-
// localhost forwarder and the engine's server-side remote delivery (ADR-0081). The fetch must OWN the
// connection-management + framing headers; everything else (notably the `webhook-*` Standard Webhooks
// signature headers) is forwarded verbatim so the receiver can still verify. RFC 7230 §6.1 hop-by-hop
// set plus host/content-length. Single-sourced so the loopback (CLI) and remote (engine) paths can't drift.

const DROP_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "proxy-authenticate",
  "proxy-authorization",
]);

/** Filter captured [name,value] pairs for forwarding: drop hop-by-hop/host/length, keep the rest. */
export function filterDeliveryHeaders(captured: readonly (readonly [string, string])[]): Headers {
  const out = new Headers();
  for (const [name, value] of captured) {
    if (!DROP_HEADERS.has(name.toLowerCase())) out.append(name, value);
  }
  return out;
}
