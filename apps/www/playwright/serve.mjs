// Minimal static file server for the built `out/` export, used only as the Playwright `webServer`
// for the a11y scan. Node built-ins only (no dep), binds to localhost, and refuses to escape `out/`.
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createGzip } from "node:zlib";

const ROOT = fileURLToPath(new URL("../out/", import.meta.url));
const PORT = Number(process.env.PORT) || 4321;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

// Compress text-like assets so transfer sizes mirror production (Cloudflare gzip/brotli) — this is
// what the Lighthouse byte-weight / LCP budgets are measured against.
const COMPRESSIBLE = new Set([".html", ".js", ".mjs", ".css", ".json", ".svg", ".xml", ".txt"]);

// Map a URL path to a file inside ROOT, never outside it. Returns null on a malformed URL or a
// traversal attempt (decodeURIComponent throws on a stray `%`, which must not crash the server).
function toFile(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split("?")[0]);
  } catch {
    return null;
  }
  const candidate = resolve(ROOT, `.${decoded}`);
  // Reject anything that escapes ROOT. The relative()-based containment check is the canonical
  // path-traversal barrier and the form static analysis (CodeQL js/path-injection) recognizes as a
  // sanitizer — `rel` is "" or a forward relative path for contained files, and starts with ".."
  // (or is absolute) for an escape.
  const rel = relative(ROOT, candidate);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return candidate;
}

async function pick(file) {
  try {
    const s = await stat(file);
    return s.isDirectory() ? join(file, "index.html") : file;
  } catch {
    try {
      await stat(`${file}.html`);
      return `${file}.html`;
    } catch {
      return null;
    }
  }
}

createServer(async (req, res) => {
  const mapped = toFile(req.url || "/");
  const file = mapped ? await pick(mapped) : null;
  if (!file) {
    const notFound = join(ROOT, "404.html");
    res.statusCode = 404;
    res.setHeader("Content-Type", MIME[".html"]);
    createReadStream(notFound)
      .on("error", () => res.end("Not found"))
      .pipe(res);
    return;
  }
  const ext = extname(file);
  res.setHeader("Content-Type", MIME[ext] || "application/octet-stream");
  const onErr = () => res.destroy();
  const stream = createReadStream(file).on("error", onErr);
  if (COMPRESSIBLE.has(ext) && (req.headers["accept-encoding"] || "").includes("gzip")) {
    res.setHeader("Content-Encoding", "gzip");
    stream.pipe(createGzip().on("error", onErr)).pipe(res);
  } else {
    stream.pipe(res);
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`serving ${ROOT.split(sep).slice(-2).join(sep)} on http://127.0.0.1:${PORT}`);
});
