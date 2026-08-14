import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { invariant } from "./errors.js";
import { hashFileContents, resolveExistingPathWithin } from "./hash.js";
import { readObject } from "./objects.js";
import { asArray, isSafeRepoPath, normalizeRepoPath, parseJson, sha256 } from "./util.js";

function normalizeLineRange(input) {
  const start = Number(input.startLine ?? input.lineStart ?? input.line ?? 1);
  const end = Number(input.endLine ?? input.lineEnd ?? start);
  invariant(Number.isInteger(start) && start >= 1, "EVIDENCE_LINE", "Evidence startLine must be a positive integer.");
  invariant(Number.isInteger(end) && end >= start, "EVIDENCE_LINE", "Evidence endLine must be at least startLine.");
  return { startLine: start, endLine: end };
}

export function sourceEvidence(projectRoot, input) {
  const rawPath = input.path ?? input.Path;
  invariant(rawPath && isSafeRepoPath(String(rawPath)), "EVIDENCE_SOURCE_PATH", `Unsafe evidence source path: ${rawPath ?? "<missing>"}.`);
  const relative = normalizeRepoPath(String(rawPath));
  const absolute = path.resolve(projectRoot, relative);
  const range = normalizeLineRange(input);
  const resolved = resolveExistingPathWithin(projectRoot, absolute);
  invariant(resolved.inside, "EVIDENCE_SOURCE_ESCAPE", `Evidence source escapes the repository: ${relative}.`);
  if (!existsSync(absolute)) {
    return { type: "source", path: relative, ...range, fileSha256: null, sliceSha256: null, missing: true };
  }
  const body = readFileSync(absolute, "utf8");
  const lines = body.split(/\r?\n/);
  const endLine = Math.min(range.endLine, Math.max(1, lines.length));
  const startLine = Math.min(range.startLine, endLine);
  const slice = lines.slice(startLine - 1, endLine).join("\n");
  return {
    type: "source",
    path: relative,
    startLine,
    endLine,
    fileSha256: hashFileContents(resolved.path),
    sliceSha256: sha256(slice),
    missing: false
  };
}

function parseSourceString(value) {
  const match = String(value).match(/^(.+?):(\d+)(?:-(\d+))?$/u);
  if (!match || !isSafeRepoPath(match[1])) return null;
  return { type: "source", path: match[1], startLine: Number(match[2]), endLine: Number(match[3] ?? match[2]) };
}

function entityReference(db, value) {
  const finding = db.prepare("SELECT id, status FROM findings WHERE id = ?").get(value);
  if (finding) return { type: "finding", id: finding.id, status: finding.status };
  const decision = db.prepare("SELECT id, status FROM decisions WHERE id = ?").get(value);
  if (decision) return { type: "decision", id: decision.id, status: decision.status };
  const artifact = db.prepare("SELECT id, kind, status, content_ref FROM artifacts WHERE id = ?").get(value);
  if (artifact) return { type: "artifact", id: artifact.id, kind: artifact.kind, status: artifact.status, contentRef: artifact.content_ref };
  const check = db.prepare("SELECT id, name, status, command_hash, output_ref, exit_code, code_fingerprint FROM checks WHERE id = ? OR name = ? ORDER BY updated_at DESC LIMIT 1")
    .get(value, value);
  if (check) {
    return {
      type: "command",
      checkId: check.id,
      name: check.name,
      status: check.status,
      commandHash: check.command_hash,
      outputRef: check.output_ref,
      exitCode: check.exit_code,
      codeFingerprint: check.code_fingerprint
    };
  }
  if (String(value).startsWith("obj_")) return { type: "object", ref: String(value) };
  return null;
}

export function normalizeEvidenceRef(db, projectRoot, ref) {
  if (typeof ref === "string") {
    const entity = entityReference(db, ref);
    if (entity) return entity;
    const source = parseSourceString(ref);
    if (source) return sourceEvidence(projectRoot, source);
    if (isSafeRepoPath(ref) && existsSync(path.join(projectRoot, ref))) {
      return sourceEvidence(projectRoot, { path: ref, startLine: 1, endLine: 1 });
    }
    return { type: "note", text: ref.slice(0, 500), verifiable: false };
  }
  invariant(ref && typeof ref === "object" && !Array.isArray(ref), "EVIDENCE_REF", "Evidence references must be strings or objects.");
  const type = String(ref.type ?? ref.Type ?? (ref.path ? "source" : "")).toLowerCase();
  if (type === "source" || type === "file") return sourceEvidence(projectRoot, ref);
  if (type === "finding") {
    const row = db.prepare("SELECT id, status FROM findings WHERE id = ?").get(ref.id ?? ref.findingId);
    invariant(row, "EVIDENCE_FINDING", "Evidence finding does not exist.");
    return { type: "finding", id: row.id, status: row.status };
  }
  if (type === "decision") {
    const row = db.prepare("SELECT id, status FROM decisions WHERE id = ?").get(ref.id ?? ref.decisionId);
    invariant(row, "EVIDENCE_DECISION", "Evidence decision does not exist.");
    return { type: "decision", id: row.id, status: row.status };
  }
  if (type === "artifact") {
    const row = db.prepare("SELECT id, kind, status, content_ref FROM artifacts WHERE id = ?").get(ref.id ?? ref.artifactId);
    invariant(row, "EVIDENCE_ARTIFACT", "Evidence artifact does not exist.");
    return { type: "artifact", id: row.id, kind: row.kind, status: row.status, contentRef: row.content_ref };
  }
  if (type === "command" || type === "check") {
    const key = ref.checkId ?? ref.id ?? ref.name;
    const row = db.prepare("SELECT id, name, status, command_hash, output_ref, exit_code, code_fingerprint FROM checks WHERE id = ? OR name = ? ORDER BY updated_at DESC LIMIT 1")
      .get(key, key);
    invariant(row, "EVIDENCE_COMMAND", "Evidence command/check does not exist.");
    return {
      type: "command",
      checkId: row.id,
      name: row.name,
      status: row.status,
      commandHash: row.command_hash,
      outputRef: row.output_ref,
      exitCode: row.exit_code,
      codeFingerprint: row.code_fingerprint
    };
  }
  if (type === "object") {
    const objectRef = ref.ref ?? ref.objectRef;
    invariant(typeof objectRef === "string" && objectRef.startsWith("obj_"), "EVIDENCE_OBJECT", "Object evidence needs an obj_ reference.");
    return { type: "object", ref: objectRef };
  }
  if (type === "note") return { type: "note", text: String(ref.text ?? "").slice(0, 500), verifiable: false };
  throw new Error(`Unsupported evidence reference type: ${type || "<missing>"}.`);
}

export function normalizeEvidenceRefs(db, projectRoot, refs) {
  return asArray(refs).slice(0, 200).map((ref) => normalizeEvidenceRef(db, projectRoot, ref));
}

export function evidenceRefIsVerifiable(ref) {
  return Boolean(ref && typeof ref === "object" && ref.type !== "note" && ref.verifiable !== false);
}

export function evidenceRefIsCurrent(db, projectRoot, ref) {
  if (!ref || typeof ref !== "object") return false;
  if (ref.type === "source") {
    if (!existsSync(path.join(projectRoot, ref.path))) return false;
    const current = sourceEvidence(projectRoot, ref);
    return current.fileSha256 === ref.fileSha256 && current.sliceSha256 === ref.sliceSha256;
  }
  if (ref.type === "finding") return db.prepare("SELECT status FROM findings WHERE id = ?").get(ref.id)?.status === "valid";
  if (ref.type === "decision") return db.prepare("SELECT status FROM decisions WHERE id = ?").get(ref.id)?.status === "active";
  if (ref.type === "artifact") {
    const row = db.prepare("SELECT status, content_ref FROM artifacts WHERE id = ?").get(ref.id);
    if (!row || !["verified", "waived"].includes(row.status) || row.content_ref !== ref.contentRef) return false;
    return row.content_ref === null || authenticatedObject(db, projectRoot, row.content_ref);
  }
  if (ref.type === "command") {
    const row = db.prepare("SELECT status, command_hash, output_ref, code_fingerprint FROM checks WHERE id = ?").get(ref.checkId);
    return Boolean(row && row.status === "passed" && row.command_hash === ref.commandHash && row.output_ref === ref.outputRef && row.code_fingerprint === ref.codeFingerprint);
  }
  if (ref.type === "object") return authenticatedObject(db, projectRoot, ref.ref);
  return false;
}

function authenticatedObject(db, projectRoot, ref) {
  if (typeof ref !== "string" || !ref.startsWith("obj_")) return false;
  const hash = ref.slice("obj_".length);
  if (!/^[0-9a-f]{64}$/iu.test(hash)) return false;
  if (!db.prepare("SELECT hash FROM objects WHERE hash = ?").get(hash)) return false;
  try {
    const content = readObject(db, projectRoot, ref);
    return sha256(content) === hash;
  } catch {
    return false;
  }
}

export function evidencePaths(refs) {
  return asArray(refs).filter((ref) => ref?.type === "source" && ref.path).map((ref) => normalizeRepoPath(ref.path));
}

export function evidenceSummary(ref) {
  if (!ref || typeof ref !== "object") return String(ref);
  if (ref.type === "source") return `${ref.path}:${ref.startLine}-${ref.endLine}@${String(ref.sliceSha256 ?? "missing").slice(0, 10)}`;
  if (ref.type === "finding" || ref.type === "decision" || ref.type === "artifact") return `${ref.type}:${ref.id}`;
  if (ref.type === "command") return `command:${ref.name}:${ref.status}`;
  if (ref.type === "object") return ref.ref;
  return `note:${ref.text ?? ""}`;
}

export function parseStoredEvidence(text) {
  return parseJson(text, []);
}
