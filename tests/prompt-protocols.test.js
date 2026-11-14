import assert from "node:assert/strict";
import test from "node:test";
import { normalizeEvidenceRef } from "../src/core/provenance.js";
import { ROLE_PROTOCOLS, renderTaskPacketPrompt, resultSchemaForRole } from "../src/core/prompt-protocols.js";

test("worker, verifier, and reviewer schemas document canonical source evidence and changed Files", () => {
  for (const role of ["worker", "verifier", "reviewer"]) {
    const schema = resultSchemaForRole(role);
    assert.deepEqual(schema.Files, []);
    assert.match(schema.ResultGuidance.Files, /Changed paths only/u);
    assert.match(schema.ResultGuidance.Files, /reviewer\/verifier tasks MUST use Files: \[\]/u);
    assert.match(schema.ResultGuidance.EvidenceRefs, /src\/file\.js:1/u);
    assert.match(schema.ResultGuidance.EvidenceRefs, /\{type:"source",path:"src\/file\.js",startLine:1,endLine:1\}/u);
    assert.match(schema.ResultGuidance.EvidenceRefs, /never \{type:"file",id:\.\.\.\}/u);

    const prompt = renderTaskPacketPrompt({ ResultSchema: schema });
    assert.match(prompt, /# RESULT SCHEMA/u);
    assert.match(prompt, /type:\\"source\\"/u);
  }
});

test("execution protocols scope verification without waiving required checks or freshness", () => {
  for (const role of ["worker", "reviewer", "verifier"]) {
    const prompt = renderTaskPacketPrompt({ Role: role, RoleProtocol: ROLE_PROTOCOLS[role] });
    assert.match(prompt, /static checks for documentation\/links, affected tests first for local code/u);
    assert.match(prompt, /Broaden when scope is uncertain/u);
    assert.match(prompt, /authoritative instructions and task contracts take precedence/u);
    assert.match(prompt, /Avoid duplicate full-suite runs against the same final state unless/u);
    assert.match(prompt, /new change, a new failure hypothesis, or an external requirement/u);
    assert.match(prompt, /full suite required by authoritative instructions or contracts must run/u);
    assert.match(prompt, /every registered required check must pass with current evidence/u);
    assert.match(prompt, /Preserve final CI and release gates/u);
    assert.match(prompt, /current source, command, inputs, configuration, and environment/u);
    assert.match(prompt, /Unchanged source alone is insufficient/u);
    assert.match(prompt, /if freshness cannot be established, execute or verify again/u);
    assert.match(prompt, /Never waive independent verification or evidence freshness/u);
  }
  assert.match(ROLE_PROTOCOLS.worker.join("\n"), /Run task-local verification and return structured evidence/u);
});

test("reviewer uses current source and typed evidence with justified additional commands", () => {
  const prompt = renderTaskPacketPrompt({ RoleProtocol: ROLE_PROTOCOLS.reviewer });
  assert.match(prompt, /Do not trust worker summaries/u);
  assert.match(prompt, /Inspect current source and valid typed evidence/u);
  assert.match(prompt, /additional commands only for a new failure hypothesis, a coverage gap, or a required check or freshness obligation/u);
  assert.match(prompt, /exact typed EvidenceRef: \{type:'artifact', id, contentRef\}/u);
  assert.match(prompt, /Do not modify implementation files/u);
});

test("verifier keeps independent criterion-level typed evidence while minimizing duplicate work", () => {
  const prompt = renderTaskPacketPrompt({ RoleProtocol: ROLE_PROTOCOLS.verifier });
  assert.match(prompt, /For each acceptance criterion, perform the minimum sufficient independent confirmation/u);
  assert.match(prompt, /never rely only on the worker's summary/u);
  assert.match(prompt, /distinct host receipt\/agent from the worker/u);
  assert.match(prompt, /exactly one AcceptanceResults entry for every acceptance criterion/u);
  assert.match(prompt, /current typed source, command, check, browser, or artifact evidence reference for every verified criterion/u);
  assert.match(prompt, /Do not replace criterion-level evidence with a worker summary/u);
  assert.match(prompt, /Do not treat a build or worker claim as behavioral proof/u);
  assert.match(prompt, /exact typed EvidenceRef: \{type:'artifact', id, contentRef\}/u);
  assert.match(prompt, /Return the exact failed criterion/u);
  assert.match(prompt, /Do not modify implementation files/u);
});

test("the ambiguous file-id evidence shape is rejected rather than treated as a source", () => {
  assert.throws(
    () => normalizeEvidenceRef({}, process.cwd(), { type: "file", id: "src/file.js" }),
    (error) => error.code === "EVIDENCE_SOURCE_PATH"
  );
});
