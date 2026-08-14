import assert from "node:assert/strict";
import test from "node:test";
import { normalizeEvidenceRef } from "../src/core/provenance.js";
import { renderTaskPacketPrompt, resultSchemaForRole } from "../src/core/prompt-protocols.js";

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

test("the ambiguous file-id evidence shape is rejected rather than treated as a source", () => {
  assert.throws(
    () => normalizeEvidenceRef({}, process.cwd(), { type: "file", id: "src/file.js" }),
    (error) => error.code === "EVIDENCE_SOURCE_PATH"
  );
});
