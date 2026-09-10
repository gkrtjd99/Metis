import { closeSync, constants, lstatSync, mkdirSync, openSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { invariant } from "./errors.js";
import { sha256 } from "./util.js";

const PRD_PATH = /^docs\/metis\/([a-z0-9][a-z0-9-]{0,80})\/prd\.md$/u;

export function goalSlug(title) {
  invariant(typeof title === "string" && title.trim(), "GOAL_DOCUMENT_TITLE", "명시적인 목표 제목이 필요합니다.");
  const normalized = title.normalize("NFC").trim().replace(/\s+/gu, " ");
  const stem = normalized.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 48).replace(/-$/u, "") || "goal";
  return `${stem}-${sha256(normalized).slice(0, 12)}`;
}

function stat(file) {
  try { return lstatSync(file); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

// The resolved repository root is the trusted anchor. Never follow descendant links.
// These checks are not a sandbox against a hostile process swapping parents concurrently.
export function inspectGoalDocuments(root, prdPath) {
  invariant(typeof prdPath === "string" && PRD_PATH.test(prdPath), "GOAL_DOCUMENT_PATH", "목표 문서는 docs/metis/<goal-slug>/prd.md 상대 경로여야 합니다.");
  const directory = path.posix.dirname(prdPath);
  const paths = { directory, prd: prdPath, plan: `${directory}/plan.md`, decisions: `${directory}/decisions.md` };
  const anchor = realpathSync(root);
  const existing = {};
  for (const [kind, relative] of Object.entries(paths)) {
    const parts = relative.split("/");
    for (let index = 0; index < parts.length; index += 1) {
      const entry = stat(path.join(anchor, ...parts.slice(0, index + 1)));
      if (!entry) break;
      const isDirectory = index < parts.length - 1 || kind === "directory";
      invariant(!entry.isSymbolicLink() && (isDirectory ? entry.isDirectory() : entry.isFile() && entry.nlink === 1),
        "GOAL_DOCUMENT_UNSAFE_PATH", "목표 문서 경로의 symlink, hardlink 또는 파일 종류 충돌을 해결해야 합니다.");
    }
    existing[kind] = Boolean(stat(path.join(anchor, relative)));
  }
  return { ...paths, existing };
}

/** PRD-only entry: no config, database, run, lifecycle, or installer bootstrap. */
export function createGoalPrd(root, title, content) {
  invariant(typeof content === "string" && content.trim() && !content.includes("\0"), "GOAL_DOCUMENT_CONTENT", "비어 있지 않은 plain Markdown PRD 본문이 필요합니다.");
  const documents = inspectGoalDocuments(root, `docs/metis/${goalSlug(title)}/prd.md`);
  // Any occupied goal directory needs an explicit read/reconciliation, never a suffix or overwrite.
  invariant(!documents.existing.directory, "GOAL_DOCUMENT_EXISTS", "목표 폴더가 이미 있습니다. 기존 문서를 읽고 같은 목표인지 확인하세요. 새 suffix나 임의 폴더를 만들지 마세요.");
  const anchor = realpathSync(root);
  for (const relative of ["docs", "docs/metis"]) {
    try { mkdirSync(path.join(anchor, relative)); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    inspectGoalDocuments(anchor, documents.prd);
  }
  // Non-recursive exclusive directory creation also fails on a concurrent slug collision.
  mkdirSync(path.join(anchor, documents.directory));
  inspectGoalDocuments(anchor, documents.prd);
  const fd = openSync(path.join(anchor, documents.prd), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
  try { writeFileSync(fd, content, "utf8"); } finally { closeSync(fd); }
  return { ...inspectGoalDocuments(anchor, documents.prd), created: true, runCreated: false };
}

/** sourceDocument's existing artifact path is the sole folder binding, never runs.goal. */
export function boundGoalDocuments(db, root, runId, sourceDocument) {
  if (!sourceDocument) return { status: "unbound", reason: "no-source-document" };
  const artifact = db.prepare("SELECT path FROM artifacts WHERE id = ? AND run_id = ? AND content_ref = ? AND kind = 'prd' AND status = 'verified'")
    .get(sourceDocument.artifactId, runId, sourceDocument.contentRef);
  invariant(artifact, "GOAL_DOCUMENT_SOURCE", "현재 run의 인증된 PRD snapshot이 필요합니다.");
  if (!PRD_PATH.test(artifact.path ?? "")) return { status: "unbound", reason: "legacy-or-external-source-path" };
  return { status: "bound", ...inspectGoalDocuments(root, artifact.path), authority: "runtime", sourceArtifactId: sourceDocument.artifactId };
}
