import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import { gzipSync } from "node:zlib";
import { readFileSync, readFileSync as readBytes, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { objectKeyPath, readObject, storeObject } from "../src/core/objects.js";
import { makeProject } from "./helpers.js";

function objectFile(root, row) {
  return path.join(root, ".metis", row.path);
}

function projectKey(root) {
  if (process.env.METIS_OBJECT_KEY) {
    const value = process.env.METIS_OBJECT_KEY.trim();
    return /^[0-9a-f]{64}$/iu.test(value) ? Buffer.from(value, "hex") : Buffer.from(value, "base64");
  }
  return Buffer.from(readFileSync(objectKeyPath(root), "utf8").trim(), "base64");
}

test("objects use gzip level 6, retain encrypted format, and round-trip", () => {
  const { root, db } = makeProject();
  try {
    const source = Array.from({ length: 10000 }, (_, index) => `record-${index % 97}-${String(index).padStart(5, "0")}-${"x".repeat(index % 31)}\n`).join("");
    const ref = storeObject(db, root, "performance-test", source);
    const row = db.prepare("SELECT * FROM objects WHERE hash = ?").get(ref.slice(4));
    const payload = readBytes(objectFile(root, row));
    assert.equal(payload.subarray(0, 8).toString("binary"), "METIS04\0");
    assert.equal(payload.length - 36, gzipSync(Buffer.from(source), { level: 6 }).length);
    assert.notEqual(gzipSync(Buffer.from(source), { level: 6 }).length, gzipSync(Buffer.from(source), { level: 9 }).length);
    assert.equal(readObject(db, root, ref), source);
    assert.equal(row.hash, ref.slice(4));
  } finally {
    db.close();
  }
});

test("objects deduplicate by plaintext hash and old level-9 payloads still decompress", () => {
  const { root, db } = makeProject();
  try {
    const source = "backward-compatible object content\n".repeat(4000);
    const first = storeObject(db, root, "dedup-a", source);
    const second = storeObject(db, root, "dedup-b", source);
    assert.equal(first, second);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM objects WHERE hash = ?").get(first.slice(4)).count, 1);

    const row = db.prepare("SELECT * FROM objects WHERE hash = ?").get(first.slice(4));
    const nonce = Buffer.from("00112233445566778899aabb", "hex");
    const cipher = createCipheriv("aes-256-gcm", projectKey(root), nonce);
    cipher.setAAD(Buffer.from(`${row.hash}:${row.kind}`, "utf8"));
    const encrypted = Buffer.concat([cipher.update(gzipSync(Buffer.from(source), { level: 9 })), cipher.final()]);
    const payload = Buffer.concat([Buffer.from("METIS04\0", "binary"), nonce, cipher.getAuthTag(), encrypted]);
    writeFileSync(objectFile(root, row), payload);
    assert.equal(readObject(db, root, first), source);
  } finally {
    db.close();
  }
});

test("object authentication rejects tampered encrypted content", () => {
  const { root, db } = makeProject();
  try {
    const ref = storeObject(db, root, "tamper-test", "confidential content");
    const row = db.prepare("SELECT * FROM objects WHERE hash = ?").get(ref.slice(4));
    const file = objectFile(root, row);
    const payload = Buffer.from(readFileSync(file));
    payload[payload.length - 1] ^= 1;
    writeFileSync(file, payload);
    assert.throws(() => readObject(db, root, ref));
  } finally {
    db.close();
  }
});
