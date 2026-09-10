import { listDocumentImpacts } from "./docs.js";
import { listDecisions, listFindings } from "./evidence.js";
import { listChecks } from "./checks.js";
import { syncRepository } from "./repository.js";
import { fastPathV2ApprovalCurrent, isFastPathV2, putArtifact } from "./state.js";
import { buildProjectKnowledgeIndex } from "./project-knowledge.js";

export function synchronizeKnowledge(db, projectRoot, runId, config) {
  const repository = syncRepository(db, projectRoot, config, runId);
  const projectKnowledge = buildProjectKnowledgeIndex(db, projectRoot);
  const pendingDocuments = listDocumentImpacts(db, runId, "pending");
  const staleFindings = listFindings(db, runId, { status: "stale" });
  const decisionsNeedingReview = listDecisions(db, runId, "needs-review");
  const invalidChecks = listChecks(db, runId).filter((check) => check.required && check.status !== "passed");
  const fastV2 = isFastPathV2(db, projectRoot, runId);
  const completionState = fastV2 ? fastPathV2ApprovalCurrent(db, projectRoot, runId, "completion") : null;
  const completionApproval = completionState?.pass ? completionState.artifact : null;
  const clean = pendingDocuments.length === 0
    && staleFindings.length === 0
    && decisionsNeedingReview.length === 0
    && invalidChecks.length === 0
    && (!fastV2 || Boolean(completionApproval));
  const summary = {
    clean,
    ...(fastV2 ? {
      source: "bounded-fast-path-v2",
      fastPathProfileVersion: 2,
      policy: "deterministic-knowledge-record-no-semantic-curator-approval",
      semanticApproval: false,
      derivedFrom: completionApproval ? { artifactId: completionApproval.id, contentRef: completionApproval.content_ref } : null
    } : {}),
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
      metadata: {
        generatedIndexes: summary.generatedIndexes,
        ...(fastV2 ? {
          source: "bounded-fast-path-v2",
          fastPathProfileVersion: 2,
          policy: "deterministic-knowledge-record-no-semantic-curator-approval",
          semanticApproval: false,
          completionReviewArtifactId: completionApproval.id,
          completionReviewContentRef: completionApproval.content_ref
        } : {})
      }
    });
    return { ...summary, artifactId: artifact.id };
  }
  return summary;
}
