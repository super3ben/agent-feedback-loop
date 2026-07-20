import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import path from "node:path";

const MAX_RESULT_BYTES = 256 * 1024;
const MAX_PATH_BYTES = 4_096;

function invalidResultFile() {
  const error = new Error("invalid secure reviewer result file");
  error.code = "reviewer_result_file_invalid";
  return error;
}

function validPath(value) {
  return typeof value === "string"
    && value.length > 0
    && !value.includes("\0")
    && Buffer.byteLength(value, "utf8") <= MAX_PATH_BYTES
    && path.isAbsolute(value);
}

function currentUid() {
  if (typeof process.getuid !== "function") throw invalidResultFile();
  return process.getuid();
}

async function removeSameOwnedFile(filePath, identity) {
  let current;
  try {
    current = await lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (!current.isFile() || current.isSymbolicLink()) return;
  if (current.uid !== currentUid()) return;
  if (current.dev !== identity.dev || current.ino !== identity.ino) return;
  await unlink(filePath);
}

export async function readSecureReviewerResult(filePath) {
  if (!validPath(filePath)) throw invalidResultFile();
  let handle = null;
  let identity = null;
  try {
    handle = await open(
      filePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
    );
    const info = await handle.stat();
    identity = { dev: info.dev, ino: info.ino };
    if (!info.isFile()
        || info.uid !== currentUid()
        || (info.mode & 0o7777) !== 0o600
        || info.size < 1
        || info.size > MAX_RESULT_BYTES) {
      throw invalidResultFile();
    }
    const bounded = Buffer.allocUnsafe(MAX_RESULT_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < bounded.length) {
      const result = await handle.read(
        bounded,
        bytesRead,
        bounded.length - bytesRead,
        bytesRead
      );
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead < 1 || bytesRead > MAX_RESULT_BYTES) throw invalidResultFile();
    const bytes = bounded.subarray(0, bytesRead);
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw invalidResultFile();
    }
    try {
      return JSON.parse(text);
    } catch {
      throw invalidResultFile();
    }
  } finally {
    try {
      if (handle) await handle.close();
    } finally {
      if (identity) await removeSameOwnedFile(filePath, identity);
    }
  }
}
