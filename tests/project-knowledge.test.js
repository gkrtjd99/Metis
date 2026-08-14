import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { addDecision, addFinding } from "../src/core/evidence.js";
import { buildProjectKnowledgeIndex, searchProjectKnowledge } from "../src/core/project-knowledge.js";
import { pauseRun, startRun } from "../src/core/state.js";
import { makeProject } from "./helpers.js";

test("project knowledge search reuses valid findings and decisions across goals", () => {
  const { root, config, db } = makeProject();
  try {
    writeFileSync(path.join(root, "auth.js"), "export const provider = 'redis';\n");
    const first = startRun(db, root, config, "Document authentication architecture").run;
    const finding = addFinding(db, root, first.id, {
      claim: "Authentication sessions use Redis.",
      kind: "fact",
      sources: [{ path: "auth.js", lineStart: 1, lineEnd: 1 }]
    });
    addDecision(db, first.id, {
      title: "Reuse Redis sessions",
      decision: "Keep Redis as the session authority.",
      rationale: "The repository already uses Redis.",
      evidenceRefs: [finding.id],
      affects: ["auth.js"]
    });
    const generated = buildProjectKnowledgeIndex(db, root);
    assert.equal(generated.counts.decisions, 1);
    assert.ok(existsSync(path.join(root, ".metis/generated/knowledge-index.json")));
    assert.ok(existsSync(path.join(root, ".metis/generated/adr-proposals.json")));
    assert.ok(existsSync(path.join(root, ".metis/generated/ADR_PROPOSALS.md")));
    const proposals = JSON.parse(readFileSync(path.join(root, ".metis/generated/adr-proposals.json"), "utf8"));
    assert.match(proposals.proposals[0].decisionId, /^dec_/u);
    assert.equal(proposals.proposals[0].decision, "Keep Redis as the session authority.");
    assert.match(proposals.proposals[0].suggestedPath, /^docs\/decisions\//u);

    pauseRun(db, first.id, "The first knowledge capture is complete.");
    startRun(db, root, config, "Add login throttling");
    const results = searchProjectKnowledge(db, "Redis authentication", 10);
    assert.ok(results.some((item) => item.id === finding.id));
    assert.ok(results.some((item) => item.type === "decision"));
  } finally {
    db.close();
  }
});
