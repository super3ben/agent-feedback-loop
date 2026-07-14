import assert from "node:assert/strict";
import { chmod, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { readSecureReceipt } from "../src/reviewer-auth.mjs";

test("secure receipt accepts only a complete private regular file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "afl-receipt-"));
  const valid = path.join(root, "valid.json");
  const payload = { write_complete: true, review_receipt_id: "r", reviewer_capability: "token", background_agent_id: "agent-1" };
  await writeFile(valid, JSON.stringify(payload), { mode: 0o600 });
  assert.deepEqual(await readSecureReceipt(valid), payload);

  const permissive = path.join(root, "permissive.json");
  await writeFile(permissive, JSON.stringify(payload), { mode: 0o644 });
  await assert.rejects(() => readSecureReceipt(permissive), /0600|private/i);

  const partial = path.join(root, "partial.json");
  await writeFile(partial, JSON.stringify({ ...payload, write_complete: false }), { mode: 0o600 });
  await assert.rejects(() => readSecureReceipt(partial), /complete/i);

  const link = path.join(root, "link.json");
  await symlink(valid, link);
  await assert.rejects(() => readSecureReceipt(link), /regular|symlink/i);
  await chmod(valid, 0o600);
});
