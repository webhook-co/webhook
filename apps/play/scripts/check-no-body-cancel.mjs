// Guard: never cancel an INCOMING request body in the play worker.
//
// Why this is a build-breaking check and not just a code comment: cancelling `request.body` while the
// client is still sending resets the connection, and workerd surfaces that as an uncaught "Network
// connection lost" which TEARS DOWN THE DURABLE OBJECT. The practical effect was an unauthenticated
// availability bug — anyone who knew a sandbox URL could send one >64KB body and permanently kill that
// session's live stream (ingest then 503'd). It was found by driving a real `wrangler dev` with curl.
//
// The workerd test runtime CANNOT catch this: `SELF.fetch` has no real socket to reset, so the unit
// tests pass against the buggy code (mutation-checked). That is exactly why the invariant needs a
// static guard — the test suite is structurally blind to it.
//
// If you need to discard an over-cap body: refuse on Content-Length before touching the stream, or
// stop accumulating and return — but never `.cancel()` it.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SRC = new URL("../src/", import.meta.url).pathname;

// `request.body.getReader()` is stored in a local, so match a cancel on any reader-ish local too.
const FORBIDDEN = [
  /request\.body\s*(?:\?\.)?\.?cancel\s*\(/, // request.body.cancel()
  /\breader\s*\.\s*cancel\s*\(/, // const reader = request.body.getReader(); reader.cancel()
];

const offenders = [];
for (const file of readdirSync(SRC).filter((f) => f.endsWith(".ts"))) {
  const path = join(SRC, file);
  const lines = readFileSync(path, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (line.trimStart().startsWith("//") || line.trimStart().startsWith("*")) return; // prose, not code
    for (const re of FORBIDDEN) {
      if (re.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
    }
  });
}

if (offenders.length > 0) {
  console.error(
    "\n✗ Cancelling an incoming request body resets the connection and kills the Durable Object.\n" +
      "  One >64KB request would then blind a sandbox's live stream — unauthenticated.\n" +
      "  Refuse on Content-Length, or stop accumulating and return. Never .cancel() the body.\n",
  );
  for (const o of offenders) console.error(`  ${o}`);
  console.error("");
  process.exit(1);
}

console.log("✓ no incoming request body is cancelled in the play worker");
