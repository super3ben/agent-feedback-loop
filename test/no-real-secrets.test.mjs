import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCANNED = new Set([".mjs", ".js", ".json", ".md", ".sh", ".toml", ".py"]);
const SKIPPED = new Set([".git", "node_modules", ".worktrees", ".claude", ".comet", ".agent"]);

// A real complaint makes a good fixture, but a complaint often carries the
// credential that caused it. This file is checked into a public repository, so
// pasting one in leaks it no matter how careful the runtime is about logging.
const FORBIDDEN = [
  // Credential-shaped literals: a user/host followed by something password-like.
  { name: "root password literal", pattern: /\broot\s+[A-Za-z0-9]*[@!#$%^&*][A-Za-z0-9@!#$%^&*+]{4,}/u },
  { name: "private network host", pattern: /\b(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/u },
  { name: "bearer token literal", pattern: /\b(?:Bearer|Authorization:)\s+[A-Za-z0-9._-]{20,}/u },
  { name: "private key block", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u }
];

// Values that only look credential-shaped: documented placeholders, the
// loopback address a test may legitimately bind to, and the synthetic samples
// that exist precisely so the redactor can be shown to reject them. Those are
// marked, so a real secret cannot hide behind the same allowance by accident.
const ALLOWED = [
  /Example@Pass1/u,
  /\b(?:127\.0\.0\.1|10\.0\.0\.1|0\.0\.0\.0)\b/u,
  /raw-secret|synthetic-canary|REDACTED|placeholder/iu,
  /afl-synthetic-secret/u
];

async function sourceFiles(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (SKIPPED.has(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await sourceFiles(full));
    else if (SCANNED.has(path.extname(entry.name))) found.push(full);
  }
  return found;
}

test("no real credentials or private hosts are committed", async () => {
  const offences = [];
  for (const file of await sourceFiles(ROOT)) {
    if (file.endsWith("no-real-secrets.test.mjs")) continue;
    const text = await readFile(file, "utf8");
    for (const line of text.split("\n")) {
      if (ALLOWED.some((allowed) => allowed.test(line))) continue;
      for (const { name, pattern } of FORBIDDEN) {
        if (pattern.test(line)) {
          offences.push(`${path.relative(ROOT, file)}: ${name}`);
        }
      }
    }
  }
  assert.deepEqual(offences, [], `replace these with fake fixture values:\n${offences.join("\n")}`);
});
