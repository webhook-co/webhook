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
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath, not .pathname — a repo path containing a space or a '%' would otherwise stay
// percent-encoded and the guard would silently scan nothing (and pass).
const SRC = fileURLToPath(new URL("../src/", import.meta.url));

/** Every .ts under src/, RECURSIVELY — a flat readdir would miss src/lib/foo.ts entirely. */
function sources(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(path));
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

// Match the SHAPE, not an identifier name: `const r = request.body.getReader(); r.cancel()` must not
// sail through just because the local isn't called `reader`. So: flag any `.cancel(` in a file that
// also takes a reader off a request body, and flag a direct cancel on the body.
//
// `ACCESS` covers the three ways to reach through `request.body`: `.`, `?.`, and `!.` (the TypeScript
// non-null assertion). Omitting `!.` left a hole a mutation test walked straight through.
const ACCESS = String.raw`\s*!?\s*(?:\?\.|\.)\s*`;
const DIRECT_CANCEL = new RegExp(String.raw`request\.body${ACCESS}cancel\s*\(`);
const TAKES_A_READER = new RegExp(String.raw`request\.body${ACCESS}getReader\s*\(`);
const ANY_CANCEL = /\.\s*cancel\s*\(/;

const files = sources(SRC);
if (files.length === 0) {
  console.error("✗ guard scanned no files — it would pass vacuously. Check the src path.");
  process.exit(1);
}

const offenders = [];
for (const path of files) {
  const file = relative(SRC, path);
  const source = readFileSync(path, "utf8");
  const readsABody = TAKES_A_READER.test(source);
  source.split("\n").forEach((line, i) => {
    const code = line.trimStart();
    if (code.startsWith("//") || code.startsWith("*")) return; // prose, not code
    const bad = DIRECT_CANCEL.test(line) || (readsABody && ANY_CANCEL.test(line));
    if (bad) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
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
