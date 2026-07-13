#!/usr/bin/env python3
"""PACKAGED-ARTIFACT SMOKE TEST for the Python SDK.

The pytest suite imports from ``src/``. That proves the CODE works; it proves NOTHING about the WHEEL users
actually install — a missing package in ``[tool.hatch.build]``, an absent ``py.typed``, or a module that
never made it into the archive all ship green, because no test touches the built artifact.

So: build the real wheel, install it into a throwaway venv, import it as a user would, and drive it against
a live stub server. If the published artifact is unusable, this fails.

Run:  python scripts/packaged_smoke.py    (from sdks/python)
"""

from __future__ import annotations

import json
import pathlib
import shutil
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
PKG = HERE.parent

# The client script that runs INSIDE the throwaway venv, against the installed wheel.
CLIENT = r'''
import json, threading, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from webhook_co import WebhookClient

# A faithful trigger event: the SDK validates responses through pydantic, so a thin stub is (correctly)
# rejected. That strictness is a feature — the SDK will not hand you a half-parsed event.
EVENT = {
    "id": "11111111-1111-4111-8111-111111111111",
    "orgId": "22222222-2222-4222-8222-222222222222",
    "endpointId": "11111111-1111-4111-8111-111111111111",
    "receivedAt": "2026-07-13T00:00:00Z",
    "provider": "stripe",
    "dedupKey": "dk",
    "dedupStrategy": "content_hash",
    "verified": True,
    "vouched": True,
}
CALLS = []

class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, obj):
        b = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def _handle(self):
        n = int(self.headers.get("content-length") or 0)
        if n:
            self.rfile.read(n)
        CALLS.append({"method": self.command, "path": self.path, "auth": self.headers.get("authorization")})
        path, _, qs = self.path.partition("?")
        q = dict(p.split("=", 1) for p in qs.split("&") if "=" in p)
        if path == "/v1/endpoints" and self.command == "POST":
            return self._send({
                "id": "11111111-1111-4111-8111-111111111111",
                "orgId": "22222222-2222-4222-8222-222222222222",
                "name": "orders", "paused": False, "createdAt": "2026-07-13T00:00:00Z",
                "dedupConfig": None, "ingestUrl": "https://wbhk.my/whep_SEALED",
            })
        if path.endswith("/reveal-ingest-url"):
            return self._send({"ingestUrl": "https://wbhk.my/whep_SEALED"})
        if path == "/v1/usage":
            return self._send({
                "periodStart": "2026-07-01T00:00:00Z", "periodEnd": None, "capKind": "lifetime",
                "events": 42, "eventCap": 5000, "pausePolicy": "pause", "paused": False,
            })
        if path.endswith("/wait"):
            # Faithful to the server: a page WITH events returns a fresh cursor; an EMPTY page ECHOES the
            # cursor you sent; null only when you sent none. So null means "from the oldest", not "caught up".
            cur = q.get("cursor")
            if cur is None:
                return self._send({"events": [EVENT], "nextCursor": "c1", "caughtUp": False})
            return self._send({"events": [], "nextCursor": cur, "caughtUp": True})
        if path == "/v1/triggers" and self.command == "POST":
            return self._send({
                "id": "11111111-1111-4111-8111-111111111111",
                "orgId": "22222222-2222-4222-8222-222222222222",
                "endpointId": "11111111-1111-4111-8111-111111111111",
                "name": None, "createdAt": "2026-07-13T00:00:00Z", "revokedAt": None,
            })
        self._send({})

    do_GET = do_POST = do_PATCH = do_DELETE = _handle

srv = HTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
client = WebhookClient(api_key="whk_smoke_test_key_abcdefgh", base_url=f"http://127.0.0.1:{srv.server_address[1]}")

fails = []
def check(name, cond, extra=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + ("" if cond else f"  <- {extra}"))
    if not cond:
        fails.append(name)

import webhook_co
check("the installed wheel imports and exposes WebhookClient", callable(WebhookClient))

ep = client.endpoints.create(name="orders")
check("endpoints.create returns the ingest url", str(ep.ingest_url) == "https://wbhk.my/whep_SEALED", ep.ingest_url)

rev = client.endpoints.reveal_ingest_url(ep.id)
check("endpoints.reveal_ingest_url recovers the SAME url (no rotation)", str(rev.ingest_url) == str(ep.ingest_url))

check("usage.get works", client.usage.get().events == 42)

trig = client.triggers.create(endpoint_id=ep.id)
cursor, seen = None, []
for _ in range(3):
    page = client.triggers.wait(trig.id, cursor=cursor)
    seen.extend(page.events)
    cursor = page.next_cursor
check("triggers.wait drains events and terminates", len(seen) == 1, len(seen))

waits = [c for c in CALLS if "/wait" in c["path"]]
check("triggers.wait never sends a literal null cursor",
      not any("cursor=None" in c["path"] or "cursor=null" in c["path"] for c in waits),
      [c["path"] for c in waits])

client.triggers.wait(trig.id, include_body=False)
last = [c for c in CALLS if "/wait" in c["path"]][-1]
check("include_body=False serialises lowercase (the API silently ignores 'False')",
      "includeBody=false" in last["path"], last["path"])

reveal = next(c for c in CALLS if "reveal-ingest-url" in c["path"])
check("reveal is a POST carrying the bearer",
      reveal["method"] == "POST" and reveal["auth"] == "Bearer whk_smoke_test_key_abcdefgh")

srv.shutdown()
print("\npackaged Python SDK: ALL PASS" if not fails else f"\npackaged Python SDK: {len(fails)} FAILURE(S)")
sys.exit(1 if fails else 0)
'''


def main() -> int:
    scratch = pathlib.Path(tempfile.mkdtemp(prefix="py-sdk-smoke-"))
    try:
        print("building the real wheel …")
        subprocess.run(
            [sys.executable, "-m", "pip", "wheel", "--no-deps", "-w", str(scratch), str(PKG)],
            check=True,
            stdout=subprocess.DEVNULL,
        )
        wheel = next(scratch.glob("webhook_co-*.whl"))

        print(f"installing {wheel.name} into a throwaway venv …")
        venv = scratch / "venv"
        subprocess.run([sys.executable, "-m", "venv", str(venv)], check=True)
        py = venv / "bin" / "python"
        subprocess.run([str(py), "-m", "pip", "-q", "install", str(wheel)], check=True)

        script = scratch / "smoke.py"
        script.write_text(CLIENT)
        # cwd=scratch so `webhook_co` can only resolve from the INSTALLED WHEEL, never from ../src.
        return subprocess.run([str(py), str(script)], cwd=scratch).returncode
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
