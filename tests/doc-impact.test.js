import assert from "node:assert/strict";
import test from "node:test";
import { addDocumentImpact, resolveDocumentImpact } from "../src/core/docs.js";
import { startRun } from "../src/core/state.js";
import { makeProject } from "./helpers.js";

test("a repeated documentation impact reopens a resolved item", () => {
  const { root, config, db } = makeProject();
  try {
    const { run } = startRun(db, root, config, "Update an API twice");
    const first = addDocumentImpact(db, run.id, "README.md", "API changed");
    resolveDocumentImpact(db, run.id, { id: first.id }, "updated");
    const reopened = addDocumentImpact(db, run.id, "README.md", "API changed");
    assert.equal(reopened.status, "pending");
    assert.equal(reopened.disposition, null);
  } finally {
    db.close();
  }
});
