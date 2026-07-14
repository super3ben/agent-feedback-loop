import { lstat, readFile } from "node:fs/promises";

const MAX_RECEIPT_BYTES = 256 * 1024;

export async function readSecureReceipt(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("reviewer receipt must be a regular non-symlink file");
  if ((info.mode & 0o077) !== 0) throw new Error("reviewer receipt must be private mode 0600");
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error("reviewer receipt must be owned by the current user");
  if (info.size <= 0 || info.size > MAX_RECEIPT_BYTES) throw new Error("reviewer receipt size is invalid");
  const value = JSON.parse(await readFile(file, "utf8"));
  if (value.write_complete !== true) throw new Error("reviewer receipt is not marked complete");
  return value;
}
