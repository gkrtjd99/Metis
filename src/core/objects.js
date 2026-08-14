import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { now, redactSecrets, sha256 } from "./util.js";
import { runtimeArea } from "./paths.js";
import { invariant } from "./errors.js";

function projectKeyId(projectRoot) {
  // Key identity follows the physical project root, so aliases such as a
  // symlink or macOS's /var -> /private/var resolve to the same key file.
  // A missing root is still handled deterministically for callers that ask
  // for a key path before initialization creates the project directory.
  let canonicalRoot;
  try {
    canonicalRoot = realpathSync.native(projectRoot);
  } catch {
    canonicalRoot = path.resolve(projectRoot);
  }
  return sha256(canonicalRoot).slice(0, 32);
}

export function objectKeyPath(projectRoot) {
  return path.join(os.homedir(), ".config", "metis", "keys", `${projectKeyId(projectRoot)}.key`);
}

function decodeEnvironmentKey(value) {
  const trimmed = String(value ?? "").trim();
  if (/^[0-9a-f]{64}$/iu.test(trimmed)) return Buffer.from(trimmed, "hex");
  const decoded = Buffer.from(trimmed, "base64");
  return decoded.length === 32 ? decoded : null;
}

function loadObjectKey(projectRoot) {
  const environment = process.env.METIS_OBJECT_KEY;
  if (environment) {
    const key = decodeEnvironmentKey(environment);
    invariant(key, "OBJECT_KEY_INVALID", "METIS_OBJECT_KEY must contain 32 bytes as hex or base64.");
    return { key, source: "environment", path: null };
  }
  const file = objectKeyPath(projectRoot);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (!existsSync(file)) {
    writeFileSync(file, randomBytes(32).toString("base64"), { mode: 0o600, flag: "wx" });
  }
  try { chmodSync(file, 0o600); } catch {}
  const key = decodeEnvironmentKey(readFileSync(file, "utf8"));
  invariant(key, "OBJECT_KEY_INVALID", `Object-store key is invalid: ${file}`);
  return { key, source: "external-file", path: file };
}

export function objectSecurityStatus(projectRoot) {
  const loaded = loadObjectKey(projectRoot);
  return {
    encrypted: true,
    cipher: "aes-256-gcm",
    keySource: loaded.source,
    keyPath: loaded.path,
    keyOutsideRepository: loaded.path ? !path.resolve(loaded.path).startsWith(`${path.resolve(projectRoot)}${path.sep}`) : true
  };
}

export function storeObject(db, projectRoot, kind, content, options = {}) {
  const binary = Buffer.isBuffer(content);
  const source = binary
    ? content
    : Buffer.from(options.redact === true ? redactSecrets(String(content)) : String(content), "utf8");
  const hash = sha256(source);
  const existing = db.prepare("SELECT hash FROM objects WHERE hash = ?").get(hash);
  if (existing) return `obj_${hash}`;

  const compressed = gzipSync(source, { level: 6 });
  const { key } = loadObjectKey(projectRoot);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(`${hash}:${kind}`, "utf8"));
  const encrypted = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const payload = Buffer.concat([Buffer.from("METIS04\0", "binary"), nonce, authTag, encrypted]);
  const relative = path.join(hash.slice(0, 2), `${hash}.mto`);
  const absolute = path.join(runtimeArea(projectRoot, "objects"), relative);
  mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(absolute, payload, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  db.prepare(`
    INSERT OR IGNORE INTO objects(
      hash, kind, bytes, compressed_bytes, path, content_encoding, encrypted, cipher, nonce, auth_tag, created_at
    ) VALUES(?, ?, ?, ?, ?, ?, 1, 'aes-256-gcm', ?, ?, ?)
  `).run(
    hash,
    kind,
    source.length,
    payload.length,
    path.join("objects", relative).replaceAll(path.sep, "/"),
    binary ? "binary" : "utf8",
    nonce.toString("base64"),
    authTag.toString("base64"),
    now()
  );
  return `obj_${hash}`;
}

export function readObject(db, projectRoot, ref) {
  const hash = String(ref).replace(/^obj_/, "");
  const row = db.prepare("SELECT * FROM objects WHERE hash = ?").get(hash);
  if (!row) return null;
  invariant(Number(row.encrypted) === 1 && row.cipher === "aes-256-gcm", "OBJECT_FORMAT_UNSUPPORTED", "Metis reads encrypted object-store records only.");
  const relative = row.path.replace(/^objects[\\/]/u, "");
  const payload = readFileSync(path.join(runtimeArea(projectRoot, "objects"), relative));
  const magic = payload.subarray(0, 8).toString("binary");
  invariant(magic === "METIS04\0", "OBJECT_FORMAT_INVALID", `Object ${hash} has an invalid header.`);
  const nonce = payload.subarray(8, 20);
  const authTag = payload.subarray(20, 36);
  const encrypted = payload.subarray(36);
  const { key } = loadObjectKey(projectRoot);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(Buffer.from(`${hash}:${row.kind}`, "utf8"));
  decipher.setAuthTag(authTag);
  const compressed = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  const source = gunzipSync(compressed);
  return row.content_encoding === "binary" ? source : source.toString("utf8");
}
