import assert from "node:assert/strict";
import { linkSync, renameSync, writeFileSync } from "node:fs";
import { chmod, link, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { inspect } from "node:util";

import { readSecureReviewerResult } from "../src/reviewer-result-file.mjs";

const MAX_RESULT_BYTES = 256 * 1024;

async function temporaryRoot(t) {
  const root = await mkdtemp(path.join(tmpdir(), "afl-reviewer-result-file-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function writePrivate(file, contents) {
  await writeFile(file, contents, { mode: 0o600 });
  await chmod(file, 0o600);
}

async function assertMissing(file) {
  await assert.rejects(lstat(file), (error) => error?.code === "ENOENT");
}

test("reads JSON from an owned 0600 regular file and removes that file", async (t) => {
  const root = await temporaryRoot(t);
  const file = path.join(root, "result.json");
  const payload = { outcome: "no_lesson" };
  await writePrivate(file, JSON.stringify(payload));

  const before = await lstat(file);
  assert.equal(before.isFile(), true);
  assert.equal(before.mode & 0o777, 0o600);
  if (typeof process.getuid === "function") assert.equal(before.uid, process.getuid());

  assert.deepEqual(await readSecureReviewerResult(file), payload);
  await assertMissing(file);
});

test("returns unknown JSON without semantic validation and never logs result content", async (t) => {
  const root = await temporaryRoot(t);
  const validFile = path.join(root, "unknown.json");
  const malformedFile = path.join(root, "malformed.json");
  const marker = "REVIEWER_RESULT_CONTENT_MUST_STAY_PRIVATE_7d18";
  const unknownValue = {
    outcome: "not_a_declared_outcome",
    arbitrary_adapter_guess: { marker }
  };
  await writePrivate(validFile, JSON.stringify(unknownValue));
  await writePrivate(malformedFile, `{"private":"${marker}"`);

  const calls = [];
  const methods = ["debug", "error", "info", "log", "warn"];
  const originals = new Map(methods.map((method) => [method, console[method]]));
  for (const method of methods) console[method] = (...args) => calls.push([method, ...args]);

  try {
    assert.deepEqual(await readSecureReviewerResult(validFile), unknownValue);
    await assert.rejects(() => readSecureReviewerResult(malformedFile));
  } finally {
    for (const [method, original] of originals) console[method] = original;
  }

  await assertMissing(validFile);
  await assertMissing(malformedFile);
  assert.doesNotMatch(inspect(calls, { depth: 8 }), new RegExp(marker));
});

test("rejects invalid encoding, sizes, and modes and removes each owned regular file", async (t) => {
  const root = await temporaryRoot(t);
  const cases = [
    {
      name: "invalid UTF-8",
      contents: Buffer.concat([Buffer.from('{"value":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')]),
      mode: 0o600
    },
    { name: "zero bytes", contents: Buffer.alloc(0), mode: 0o600 },
    {
      name: "more than 256 KiB",
      contents: JSON.stringify({ value: "x".repeat(MAX_RESULT_BYTES) }),
      mode: 0o600
    },
    { name: "owner-read-only mode", contents: "{}", mode: 0o400 },
    { name: "group-readable mode", contents: "{}", mode: 0o640 }
  ];

  for (const candidate of cases) {
    await t.test(candidate.name, async () => {
      const file = path.join(root, `${candidate.name.replaceAll(/[^a-z0-9]+/gi, "-")}.json`);
      await writePrivate(file, candidate.contents);
      await chmod(file, candidate.mode);

      await assert.rejects(() => readSecureReviewerResult(file));
      await assertMissing(file);
    });
  }
});

test("rejects a symlink without deleting either the symlink or its target", async (t) => {
  const root = await temporaryRoot(t);
  const target = path.join(root, "target.json");
  const linkPath = path.join(root, "result.json");
  const payload = { target: "must survive" };
  await writePrivate(target, JSON.stringify(payload));
  await symlink(target, linkPath);

  await assert.rejects(() => readSecureReviewerResult(linkPath));

  assert.equal((await lstat(linkPath)).isSymbolicLink(), true);
  assert.deepEqual(JSON.parse(await readFile(target, "utf8")), payload);
});

test("cleanup compares the opened inode before unlinking a replaced path", async (t) => {
  const root = await temporaryRoot(t);

  for (const sameInode of [false, true]) {
    await t.test(sameInode ? "removes a same-inode relink" : "preserves a different-inode replacement", async () => {
      const suffix = sameInode ? "same" : "different";
      const file = path.join(root, `${suffix}.json`);
      const moved = path.join(root, `${suffix}-opened.json`);
      const originalValue = { source: suffix, value: "opened file" };
      const replacementValue = { source: suffix, value: "replacement file" };
      const serialized = JSON.stringify(originalValue);
      await writePrivate(file, serialized);

      const originalParse = JSON.parse;
      let replaced = false;
      JSON.parse = function parseWithReplacement(text, reviver) {
        if (!replaced && text === serialized) {
          replaced = true;
          renameSync(file, moved);
          if (sameInode) {
            linkSync(moved, file);
          } else {
            writeFileSync(file, JSON.stringify(replacementValue), { mode: 0o600 });
          }
        }
        return Reflect.apply(originalParse, JSON, [text, reviver]);
      };

      let result;
      try {
        result = await readSecureReviewerResult(file);
      } finally {
        JSON.parse = originalParse;
      }

      assert.equal(replaced, true);
      assert.deepEqual(result, originalValue);
      assert.deepEqual(JSON.parse(await readFile(moved, "utf8")), originalValue);

      if (sameInode) {
        await assertMissing(file);
      } else {
        assert.deepEqual(JSON.parse(await readFile(file, "utf8")), replacementValue);
        assert.notEqual((await lstat(file)).ino, (await lstat(moved)).ino);
      }
    });
  }
});

test("removing one hard-link name does not remove another name for the same inode", async (t) => {
  const root = await temporaryRoot(t);
  const file = path.join(root, "result.json");
  const alias = path.join(root, "same-inode-alias.json");
  const payload = { value: "shared inode" };
  await writePrivate(file, JSON.stringify(payload));
  await link(file, alias);
  const opened = await lstat(file);

  assert.deepEqual(await readSecureReviewerResult(file), payload);

  await assertMissing(file);
  const remaining = await lstat(alias);
  assert.equal(remaining.ino, opened.ino);
  assert.equal(remaining.dev, opened.dev);
  assert.deepEqual(JSON.parse(await readFile(alias, "utf8")), payload);
});
