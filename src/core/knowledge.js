import { listDocumentImpacts } from "./docs.js";
import { listDecisions, listFindings } from "./evidence.js";
import { listChecks } from "./checks.js";
import { syncRepository } from "./repository.js";
import { putArtifact } from "./state.js";
import { buildProjectKnowledgeIndex } from "./project-knowledge.js";

export function synchronizeKnowledge(db, projectRoot, runId, config) {
  const repository = syncRepository(db, projectRoot, config, runId);
  const projectKnowledge = buildProjectKnowledgeIndex(db, projectRoot);
  const pendingDocuments = listDocumentImpacts(db, runId, "pending");
  const staleFindings = listFindings(db, runId, { status: "stale" });
  const decisionsNeedingReview = listDecisions(db, runId, "needs-review");
  const invalidChecks = listChecks(db, runId).filter((check) => check.required && check.status !== "passed");
  const clean = pendingDocuments.length === 0
    && staleFindings.length === 0
    && decisionsNeedingReview.length === 0
    && invalidChecks.length === 0;
  const summary = {
    clean,
    repository,
    pendingDocuments: pendingDocuments.map((item) => ({ id: item.id, path: item.path, reason: item.reason })),
    staleFindings: staleFindings.map((item) => item.id),
    decisionsNeedingReview: decisionsNeedingReview.map((item) => item.id),
    invalidChecks: invalidChecks.map((item) => ({ name: item.name, status: item.status })),
    generatedIndexes: repository.generated
  };
  summary.projectKnowledge = projectKnowledge;
  summary.generatedIndexes = [...repository.generated, ...projectKnowledge.files];
  if (clean) {
    const artifact = putArtifact(db, projectRoot, runId, "knowledge-sync", summary, {
      status: "verified",
      metadata: { generatedIndexes: summary.generatedIndexes }
    });
    return { ...summary, artifactId: artifact.id };
  }
  return summary;
}
