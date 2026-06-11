#!/usr/bin/env node
// security-scan — Cursor file-edit security hook for webhook.co.
//
// Complements (does not replace) the static `eslint-plugin-security` gate: it scans the content
// the agent *just wrote* and surfaces advisory warnings with concrete remediation for a handful of
// high-signal injection / code-exec / XSS patterns. It never blocks an edit (exit 0 always) and
// it warns once per (file, pattern) per conversation so it stays quiet after the first flag.
//
// Registered in .cursor/hooks.json on:
//   - afterFileEdit  — reliable stdin: { file_path, edits: [{ old_string, new_string }] }
//   - postToolUse (matcher "Write") — carries the warning back to the agent via `additional_context`
//
// Plain Node (>=24), zero dependencies. Reads the hook JSON from stdin; prints a JSON object with
// `additional_context` on stdout (the documented agent-visible field for postToolUse) and a short
// human line on stderr (visible in Cursor's Hooks output channel). Schema: https://cursor.com/docs/hooks

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const JS_TS = /\.[mc]?[jt]sx?$/; // js jsx ts tsx mjs cjs mts cts
const GH_WORKFLOW = /\.github\/workflows\/[^/]+\.ya?ml$/;
const PYTHON = /\.py$/;

// Each rule scans freshly written content. Keep regexes simple (no nested quantifiers) so they
// stay linear-time and don't trip `security/detect-unsafe-regex` on this very file.
const RULES = [
  {
    id: "gha-command-injection",
    title: "Possible command injection in a GitHub Actions workflow",
    applies: (path) => GH_WORKFLOW.test(path),
    patterns: [
      /\$\{\{[^}]*github\.(?:event|head_ref|base_ref|issue|pull_request|comment|review)\b[^}]*\}\}/,
    ],
    fix: 'Untrusted `github.event.*` / `github.head_ref` interpolated into a `run:` block is a shell-injection sink. Pass it through an `env:` var and reference it quoted (`"$TITLE"`), or use `actions/github-script` and read from `context` instead of inlining the expression.',
  },
  {
    id: "child-process-exec",
    title: "Unsafe child_process exec/execSync with interpolated input",
    applies: (path) => JS_TS.test(path),
    patterns: [
      /\bexec(?:Sync)?\s*\(\s*`[^`]*\$\{/, // template literal with interpolation
      /\bexec(?:Sync)?\s*\(\s*["'][^"']*["']\s*\+/, // string + concatenation
    ],
    fix: 'Building a shell string from variables invites command injection. Use `execFile`/`spawn` with an argument array (`execFile("git", ["clone", url])`) so arguments are never re-parsed by a shell.',
  },
  {
    id: "dynamic-code-eval",
    title: "Dynamic code execution (eval / new Function)",
    applies: (path) => JS_TS.test(path),
    patterns: [/\beval\s*\(/, /\bnew\s+Function\s*\(/],
    fix: "`eval`/`new Function` execute arbitrary code and defeat the type system. Parse data with `JSON.parse`, dispatch via a lookup map, or import a real module instead.",
  },
  {
    id: "xss-sink",
    title: "Possible XSS via raw HTML injection",
    applies: (path) => JS_TS.test(path),
    patterns: [/dangerouslySetInnerHTML/, /\.innerHTML\s*=/],
    fix: "Assigning raw HTML lets attacker-controlled payloads reach the DOM. Render text as React children / `textContent`; if HTML is genuinely required, sanitize with a vetted sanitizer and document why.",
  },
  {
    id: "python-pickle",
    title: "Unsafe pickle deserialization",
    applies: (path) => PYTHON.test(path),
    patterns: [/\bpickle\.loads?\s*\(/],
    fix: "`pickle.load`/`loads` executes arbitrary code on untrusted input. Use `json` (or another safe format) for anything that crosses a trust boundary.",
  },
  {
    id: "python-os-system",
    title: "Shell execution via os.system",
    applies: (path) => PYTHON.test(path),
    patterns: [/\bos\.system\s*\(/],
    fix: "`os.system` runs its argument through a shell. Use `subprocess.run([...], shell=False)` with an argument list instead.",
  },
];

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function parseInput(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// Pull the path out of either shape (afterFileEdit `file_path`, or a Write tool's `tool_input`).
function extractPath(input) {
  if (typeof input.file_path === "string") return input.file_path;
  let toolInput = input.tool_input;
  if (typeof toolInput === "string") {
    try {
      toolInput = JSON.parse(toolInput);
    } catch {
      toolInput = undefined;
    }
  }
  if (toolInput && typeof toolInput === "object") {
    for (const key of ["file_path", "path", "target_file", "filePath"]) {
      if (typeof toolInput[key] === "string") return toolInput[key];
    }
  }
  return "";
}

// Scan only what was just written: the `new_string` fragments (afterFileEdit) or the written
// contents (Write tool). This stays advisory and avoids re-reading the file off disk.
function extractContent(input) {
  if (Array.isArray(input.edits)) {
    return input.edits
      .map((edit) => (edit && typeof edit.new_string === "string" ? edit.new_string : ""))
      .join("\n");
  }
  let toolInput = input.tool_input;
  if (typeof toolInput === "string") {
    try {
      toolInput = JSON.parse(toolInput);
    } catch {
      toolInput = undefined;
    }
  }
  if (toolInput && typeof toolInput === "object") {
    const parts = [];
    for (const key of ["contents", "content", "new_string", "text", "code"]) {
      if (typeof toolInput[key] === "string") parts.push(toolInput[key]);
    }
    return parts.join("\n");
  }
  return "";
}

// Session-scoped dedupe: remember which (file, rule) pairs we've already flagged this conversation
// so the agent isn't nagged on every subsequent edit. Best-effort; any failure just means we may
// warn again, which is harmless.
const STATE_DIR = join(tmpdir(), "cursor-webhook-security-scan");

function stateFileFor(conversationId) {
  const safe = String(conversationId || "default").replace(/[^A-Za-z0-9_-]/g, "_");
  return join(STATE_DIR, `${safe}.json`);
}

function loadSeen(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

function saveSeen(path, seen) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(path, JSON.stringify([...seen]), "utf8");
  } catch {
    // ignore — dedupe is an optimization, not a correctness requirement
  }
}

function main() {
  const input = parseInput(readStdin());
  const filePath = extractPath(input);
  const content = extractContent(input);
  if (!filePath || !content) {
    process.stdout.write("{}\n");
    return;
  }

  const statePath = stateFileFor(input.conversation_id);
  const seen = loadSeen(statePath);
  const findings = [];

  for (const rule of RULES) {
    if (!rule.applies(filePath)) continue;
    const hit = rule.patterns.some((pattern) => pattern.test(content));
    if (!hit) continue;
    const key = `${filePath}::${rule.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push(`- ${rule.title} (${rule.id}). ${rule.fix}`);
  }

  if (findings.length === 0) {
    process.stdout.write("{}\n");
    return;
  }

  saveSeen(statePath, seen);

  const header =
    "Security scan flagged the content just written (advisory — eslint-plugin-security remains the gate):";
  const message = `${header}\n${findings.join("\n")}\nReview and remediate before relying on this code.`;

  process.stderr.write(`[security-scan] ${findings.length} warning(s) in ${filePath}\n`);
  process.stdout.write(`${JSON.stringify({ additional_context: message })}\n`);
}

main();
