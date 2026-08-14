import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stateDirectory } from "./db.js";
import { now, parseJson, stableStringify } from "./util.js";

function decisionRows(db) {
  return db.prepare(`
    SELECT d.*, r.goal AS run_goal
    FROM decisions d
    JOIN runs r ON r.id = d.run_id
    WHERE d.status = 'active'
    ORDER BY d.updated_at DESC
  `).all().map((row) => ({
    type: "decision",
    id: row.id,
    runId: row.run_id,
    runGoal: row.run_goal,
    title: row.title,
    text: row.decision,
    rationale: row.rationale,
    evidenceRefs: parseJson(row.evidence_refs_json, []),
    affects: parseJson(row.affects_json, []),
    updatedAt: row.updated_at
  }));
}

function findingRows(db) {
  return db.prepare(`
    SELECT f.*, r.goal AS run_goal
    FROM findings f
    JOIN runs r ON r.id = f.run_id
    WHERE f.status = 'valid'
    ORDER BY CASE f.severity WHEN 'critical' THEN 5 WHEN 'error' THEN 4 WHEN 'warning' THEN 3 ELSE 1 END DESC,
             f.updated_at DESC
  `).all().map((row) => ({
    type: "finding",
    id: row.id,
    runId: row.run_id,
    runGoal: row.run_goal,
    kind: row.kind,
    severity: row.severity,
    text: row.claim,
    relevance: row.relevance,
    sources: parseJson(row.sources_json, []).map((source) => ({
      path: source.path,
      lineStart: source.lineStart,
      lineEnd: source.lineEnd,
      sha256: source.sha256
    })),
    updatedAt: row.updated_at
  }));
}

function slug(value) {
  return String(value ?? "decision")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64) || "decision";
}

function adrRecommended(entry) {
  const text = [entry.title, entry.text, entry.rationale, ...(entry.affects ?? [])].join(" ").toLowerCase();
  return /(architect|security|auth|database|schema|storage|runtime|infrastructure|public api|protocol|dependency|distributed|migration|compatib)/u.test(text)
    || (entry.affects ?? []).length >= 2;
}

function adrProposals(entries) {
  return entries
    .filter((entry) => entry.type === "decision")
    .map((entry) => ({
      decisionId: entry.id,
      title: entry.title,
      context: entry.runGoal,
      decision: entry.text,
      rationale: entry.rationale,
      affects: entry.affects ?? [],
      evidenceRefs: entry.evidenceRefs ?? [],
      recommended: adrRecommended(entry),
      suggestedPath: `docs/decisions/${entry.id}-${slug(entry.title)}.md`,
      status: "proposal"
    }));
}

export function projectKnowledgeEntries(db) {
  return [...decisionRows(db), ...findingRows(db)];
}

export function buildProjectKnowledgeIndex(db, projectRoot) {
  const entries = projectKnowledgeEntries(db);
  const proposals = adrProposals(entries);
  const directory = path.join(stateDirectory(projectRoot), "generated");
  mkdirSync(directory, { recursive: true });
  const payload = {
    generatedAt: now(),
    counts: {
      decisions: entries.filter((entry) => entry.type === "decision").length,
      findings: entries.filter((entry) => entry.type === "finding").length
    },
    entries
  };
  writeFileSync(path.join(directory, "knowledge-index.json"), `${stableStringify(payload)}\n`, "utf8");
  const markdown = [
    "# Generated Project Knowledge Index",
    "",
    `Active decisions: ${payload.counts.decisions}`,
    `Valid findings: ${payload.counts.findings}`,
    "",
    "## Decisions",
    "",
    ...entries.filter((entry) => entry.type === "decision").slice(0, 100)
      .map((entry) => `- \`${entry.id}\` ${entry.title}: ${entry.text}`),
    "",
    "## Findings",
    "",
    ...entries.filter((entry) => entry.type === "finding").slice(0, 100)
      .map((entry) => `- \`${entry.id}\` [${entry.kind}/${entry.severity}] ${entry.text}`),
    ""
  ].join("\n");
  writeFileSync(path.join(directory, "PROJECT_KNOWLEDGE.md"), markdown, "utf8");
  writeFileSync(path.join(directory, "adr-proposals.json"), `${stableStringify({
    version: 1,
    generatedAt: now(),
    proposals
  })}\n`, "utf8");
  const adrMarkdown = [
    "# Generated ADR Proposals",
    "",
    "These entries are review prompts. They do not replace human-authored architecture decisions.",
    "",
    ...proposals.flatMap((proposal) => [
      `## ${proposal.title}`,
      "",
      `- Decision: \`${proposal.decisionId}\``,
      `- Recommendation: ${proposal.recommended ? "record a durable ADR" : "record only when the decision has long-term impact"}`,
      `- Suggested path: \`${proposal.suggestedPath}\``,
      `- Context: ${proposal.context}`,
      `- Decision: ${proposal.decision}`,
      `- Rationale: ${proposal.rationale}`,
      `- Affects: ${(proposal.affects ?? []).join(", ") || "not specified"}`,
      ""
    ])
  ].join("\n");
  writeFileSync(path.join(directory, "ADR_PROPOSALS.md"), adrMarkdown, "utf8");
  return {
    counts: payload.counts,
    adrProposals: {
      total: proposals.length,
      recommended: proposals.filter((proposal) => proposal.recommended).length
    },
    files: ["knowledge-index.json", "PROJECT_KNOWLEDGE.md", "adr-proposals.json", "ADR_PROPOSALS.md"]
  };
}

function tokens(value) {
  return [...new Set(String(value ?? "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}_./-]+/u)
    .filter((token) => token.length >= 2))];
}

export function searchProjectKnowledge(db, query, limit = 12) {
  const phrase = String(query ?? "").trim().toLowerCase();
  const terms = tokens(phrase);
  const scored = projectKnowledgeEntries(db).map((entry) => {
    const haystack = [
      entry.id,
      entry.runGoal,
      entry.title,
      entry.text,
      entry.rationale,
      entry.relevance,
      ...(entry.affects ?? []),
      ...(entry.sources ?? []).map((source) => source.path)
    ].filter(Boolean).join(" ").toLowerCase();
    let score = phrase && haystack.includes(phrase) ? 20 : 0;
    for (const term of terms) {
      if (haystack.includes(term)) score += term.includes("/") || term.includes(".") ? 5 : 2;
    }
    if (entry.type === "decision") score += 1;
    return { score, entry };
  });
  const candidates = terms.length === 0
    ? scored
    : scored.filter((item) => item.score > 0);
  return candidates
    .sort((a, b) => b.score - a.score || String(b.entry.updatedAt).localeCompare(String(a.entry.updatedAt)))
    .slice(0, limit)
    .map(({ score, entry }) => ({ score, ...entry }));
}
