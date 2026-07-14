import { chmod, link, lstat, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import path from "node:path";

function assertOwned(info, label) {
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error(`${label} must be owned by the current user`);
}

async function ensurePrivateDirectory(directory, label) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (info.isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  if (!info.isDirectory()) throw new Error(`${label} must be a directory`);
  assertOwned(info, label);
  await chmod(directory, 0o700);
}

async function readPrivateRegularFile(file, label) {
  const info = await lstat(file);
  if (info.isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  if (!info.isFile()) throw new Error(`${label} must be a regular file`);
  assertOwned(info, label);
  await chmod(file, 0o600);
  return readFile(file);
}

export class BlobKeyProvider {
  constructor({ keyRoot }) {
    this.keyRoot = keyRoot;
    this.keyFile = path.join(keyRoot, "data-key.bin");
  }

  async getKey() {
    await ensurePrivateDirectory(this.keyRoot, "key root");
    try {
      const key = await readPrivateRegularFile(this.keyFile, "data key");
      if (key.length !== 32) throw new Error("data key must be exactly 32 bytes");
      return key;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const key = randomBytes(32);
      await writeFile(this.keyFile, key, { mode: 0o600, flag: "wx" }).catch(async (writeError) => {
        if (writeError.code === "EEXIST") return;
        throw writeError;
      });
      const stored = await readPrivateRegularFile(this.keyFile, "data key");
      if (stored.length !== 32) throw new Error("data key must be exactly 32 bytes");
      return stored;
    }
  }
}

export class EncryptedBlobStore {
  constructor({ root, keyProvider }) {
    this.root = root;
    this.keyProvider = keyProvider;
  }

  async write(contentHash, rawText) {
    if (!/^[a-f0-9]{64}$/i.test(String(contentHash))) throw new Error("content hash must be a 64-character hex hash");
    const file = path.join(this.root, `${contentHash}.enc`);
    await ensurePrivateDirectory(this.root, "blob root");
    try {
      const existing = await lstat(file);
      if (!existing.isFile() || existing.isSymbolicLink()) throw new Error("encrypted blob target must be a regular file and not a symlink");
      assertOwned(existing, "encrypted blob");
      await chmod(file, 0o600);
      return file;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const key = await this.keyProvider.getKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(String(rawText), "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const envelope = Buffer.concat([Buffer.from("AFL1"), iv, tag, ciphertext]);
    const temporary = path.join(this.root, `.${contentHash}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
    await writeFile(temporary, envelope, { mode: 0o600, flag: "wx" });
    try {
      await link(temporary, file);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = await lstat(file);
      if (!existing.isFile() || existing.isSymbolicLink()) throw new Error("encrypted blob target must be a regular file and not a symlink");
      assertOwned(existing, "encrypted blob");
    } finally {
      await rm(temporary, { force: true });
    }
    await chmod(file, 0o600);
    return file;
  }

  async read(file) {
    await ensurePrivateDirectory(this.root, "blob root");
    const resolved = path.resolve(file);
    if (path.dirname(resolved) !== path.resolve(this.root) || !/^[a-f0-9]{64}\.enc$/i.test(path.basename(resolved))) throw new Error("encrypted blob path is outside the blob root");
    const envelope = await readPrivateRegularFile(resolved, "encrypted blob");
    if (envelope.subarray(0, 4).toString() !== "AFL1") throw new Error("invalid encrypted blob envelope");
    const key = await this.keyProvider.getKey();
    const decipher = createDecipheriv("aes-256-gcm", key, envelope.subarray(4, 16));
    decipher.setAuthTag(envelope.subarray(16, 32));
    return Buffer.concat([decipher.update(envelope.subarray(32)), decipher.final()]).toString("utf8");
  }

  async remove(contentHash) {
    if (!/^[a-f0-9]{64}$/i.test(String(contentHash))) throw new Error("content hash must be a 64-character hex hash");
    await ensurePrivateDirectory(this.root, "blob root");
    await rm(path.join(this.root, `${contentHash}.enc`), { force: true });
  }

  async pruneUnreferenced(referencedPaths, { beforeMs = Date.now() - 60 * 60 * 1000 } = {}) {
    await ensurePrivateDirectory(this.root, "blob root");
    const referenced = new Set((referencedPaths || []).map((file) => path.resolve(file)));
    const removed = [];
    for (const name of await readdir(this.root)) {
      if (!/^[a-f0-9]{64}\.enc$/i.test(name)) continue;
      const file = path.join(this.root, name);
      if (referenced.has(path.resolve(file))) continue;
      const info = await stat(file);
      if (info.mtimeMs > beforeMs) continue;
      await rm(file, { force: true });
      removed.push(file);
    }
    return removed;
  }
}
