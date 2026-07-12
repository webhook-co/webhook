#!/usr/bin/env bash
# Drive a LOCAL /play worker end-to-end: mint a sandbox, fire every verb at it (plus the nasty
# payloads), and tail the SSE stream so you can see the captures land. Dev-only — it talks to
# `wrangler dev` on localhost and is never deployed.
#
#   Terminal 1:  cd apps/play && npx wrangler dev --port 8799
#   Terminal 2:  ./scripts/drive-local.sh
#
# It exists because /play is the one surface where the sandbox is the product: the fast way to know
# it still works is to actually send it traffic, not to read a test name.
set -euo pipefail

ORIGIN="${PLAY_ORIGIN:-http://localhost:8799}"
HDRS="$(mktemp -t play-headers)"
trap 'rm -f "$HDRS"' EXIT

echo "▸ minting a sandbox at $ORIGIN"
MINT="$(curl -sS -X POST "$ORIGIN/api/mint" \
  -H 'content-type: application/json' \
  -H 'origin: http://localhost:3100' \
  -D "$HDRS" -d '{}')"

# The per-IP mint cap (PLAY_MAX_PER_IP, default 5) is a real circuit-breaker and you WILL hit it when
# driving this repeatedly — sandboxes are only released by expiry, never by hand. Say so plainly.
case "$MINT" in
  *rate_limited*)
    echo "✗ mint refused: per-IP budget spent (that's the circuit-breaker doing its job)." >&2
    echo "  Either wait for the 15-minute TTL, or restart the dev worker with a bigger local cap:" >&2
    echo "    npx wrangler dev --port 8799 --var PLAY_MAX_PER_IP:500" >&2
    exit 1 ;;
esac

TOKEN="$(printf '%s' "$MINT" | sed -n 's/.*"token":"\([0-9a-f]*\)".*/\1/p')"
# The viewer secret rides in a Secure cookie. curl will NOT send a Secure cookie over http — not even
# to localhost (browsers grant loopback an exception; curl doesn't) — so a cookie jar silently yields
# an unauthenticated stream. Read it out of the Set-Cookie header and send it explicitly.
VIEWER="$(sed -n 's/.*\(pv_[0-9a-f]*=[0-9a-f]*\).*/\1/p' "$HDRS" | head -1)"
URL="$(printf '%s' "$MINT" | sed -n 's/.*"ingestUrl":"\([^"]*\)".*/\1/p')"
[ -n "$TOKEN" ] || { echo "✗ mint failed: $MINT" >&2; exit 1; }

echo "  token:     $TOKEN"
echo "  ingestUrl: $URL"
# Guards the exact bug that made this script necessary: an https://localhost URL is unreachable.
case "$URL" in
  https://localhost*|https://127.0.0.1*) echo "✗ advertised an https:// loopback URL — ERR_SSL_PROTOCOL_ERROR" >&2; exit 1 ;;
esac

echo
echo "▸ sending one request per verb (live ingest accepts them all — /play must too)"
for V in GET POST PUT PATCH DELETE OPTIONS HEAD; do
  CODE="$(curl -fsS -o /dev/null -w '%{http_code}' -X "$V" "$URL" \
    -H 'content-type: application/json' -d "{\"verb\":\"$V\"}" || echo ERR)"
  printf '  %-7s → %s\n' "$V" "$CODE"
done

echo
echo "▸ hostile payloads (these must be captured and rendered inert, never executed)"
curl -fsS -o /dev/null -X POST "$URL" -H 'content-type: application/json' \
  -d '{"xss":"<script>alert(1)</script>","img":"<img src=x onerror=alert(1)>"}' && echo "  xss payload      → captured"

# THE REGRESSION THIS SCRIPT EXISTS FOR. An oversized body used to reset the connection (readCapped
# cancelled the incoming stream), which took the Durable Object down with it: the sandbox's live stream
# went dead forever and its ingest started 503ing — triggerable by anyone who knew the URL. The workerd
# test runtime cannot reproduce it (no real socket), so this is where it's actually caught.
OVER="$(head -c 70000 /dev/zero | tr '\0' 'A' | curl -sS -o /dev/null -w '%{http_code}' -X POST "$URL" --data-binary @-)"
printf '  oversized (>64KB) → %s (expect 413)\n' "$OVER"
[ "$OVER" = "413" ] || { echo "✗ expected 413 for an over-cap body, got $OVER" >&2; exit 1; }

AFTER="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$URL" -d 'after-the-413')"
printf '  ingest still alive after the 413 → %s (expect 200; was 503 before the fix)\n' "$AFTER"
[ "$AFTER" = "200" ] || { echo "✗ the 413 wedged the session — this is the DO-teardown regression" >&2; exit 1; }

echo
echo "▸ replaying the stream (the viewer cookie authenticates it — no secret in the URL)"
# The DO replays its backlog on connect, so everything above should appear here. Buffer to a file
# first: piping curl straight into sed means the pipe is still buffered when --max-time kills it, and
# you see nothing even though the stream was perfect.
STREAM="$(mktemp -t play-stream)"
trap 'rm -f "$HDRS" "$STREAM"' EXIT
curl -sS --max-time 3 -H "cookie: $VIEWER" -H 'accept: text/event-stream' \
  "$ORIGIN/$TOKEN/stream" -o "$STREAM" 2>/dev/null || true
RECORDS="$(grep -c '^data: ' "$STREAM" || true)"
printf '  %s records replayed:\n' "$RECORDS"
sed -n 's/.*"method":"\([A-Z]*\)".*"bodyBytes":\([0-9]*\).*/    \1 (\2 bytes)/p' "$STREAM"
# The viewer must still be able to WATCH after the 413 — that's the half of the regression the 200 above
# doesn't prove (captures were still landing; the owner just couldn't see them).
[ "$RECORDS" -gt 0 ] || { echo "✗ the stream replayed nothing — the viewer is blind" >&2; exit 1; }
grep -q 'after-the-413' "$STREAM" || { echo "✗ the post-413 capture never reached the viewer" >&2; exit 1; }

echo
echo "▸ and WITHOUT the cookie the very same stream must be refused (session-bound, not URL-bound)"
printf '  bare token url → %s (expect 403)\n' \
  "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 -H 'accept: text/event-stream' "$ORIGIN/$TOKEN/stream")"

echo
echo "✓ done. The sandbox self-destructs on its own alarm; nothing to clean up."
