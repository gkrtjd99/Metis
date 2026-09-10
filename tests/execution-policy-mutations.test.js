import assert from "node:assert/strict";
import test from "node:test";

import { freezeGoalContract } from "../src/core/contracts.js";
import { sealPlan, addTask } from "../src/core/tasks.js";
import { startRun } from "../src/core/state.js";
import { forcePhase, makeProject } from "./helpers.js";

test("failed plan sealing rolls back newly applied approved execution settings", () => {
  const { root, db, config } = makeProject({
    config: {
      host: "claude",
      models: {
        capabilities: {
          claude: {
            models: {
              "default-model": ["low", "medium"],
              "approved-model": ["low", "medium", "high"]
            }
          }
        }
      }
    }
  });
  try {
    const started = startRun(db, root, config, "Exercise plan seal rollback");
    freezeGoalContract(db, root, started.run.id, {
      objective: "Exercise plan seal rollback",
      scope: ["src/parser.js"],
      nonGoals: ["Unrelated changes"],
      constraints: ["Keep plan sealing transactional"],
      successCriteria: ["A failed seal leaves task routing unchanged."],
      complexity: "trivial",
      route: { lifecycleProfile: "fast" },
      requirements: [{ id: "REQ-001", title: "Preserve route state", acceptance: ["A failed seal leaves task routing unchanged."] }]
    });
    forcePhase(db, root, config, started.run.id, "plan");
    addTask(db, started.run.id, {
      id: "rollback-task",
      title: "Rollback task",
      goal: "Exercise rollback",
      role: "worker",
      taskKind: "implementation",
      runPhase: "execute",
      wave: 1,
      readOnly: true,
      scope: ["src/parser.js"],
      requirementIds: ["REQ-001"],
      acceptanceCriteria: ["The route remains unchanged after a failed seal."],
      requiredEvidence: [],
      expectedOutputs: ["result"],
      verificationModes: [],
      dependsOn: []
    }, config);
    addTask(db, started.run.id, {
      id: "rollback-task-two",
      title: "Rollback task two",
      goal: "Exercise rollback two",
      role: "worker",
      taskKind: "implementation",
      runPhase: "execute",
      wave: 1,
      readOnly: true,
      scope: ["src/parser.js"],
      requirementIds: ["REQ-001"],
      acceptanceCriteria: ["The route remains unchanged after a failed seal."],
      requiredEvidence: [],
      expectedOutputs: ["result"],
      verificationModes: [],
      dependsOn: []
    }, config);
    const before = db.prepare(`SELECT id, selected_model, requested_effort, effective_effort,
      effort_source, supported_efforts_json, capability_status, reasoning_effort
      FROM tasks WHERE run_id = ? ORDER BY id`).all(started.run.id);
    db.prepare("INSERT INTO task_dependencies(task_id, depends_on) VALUES(?, ?)").run("rollback-task", "rollback-task-two");
    db.prepare("INSERT INTO task_dependencies(task_id, depends_on) VALUES(?, ?)").run("rollback-task-two", "rollback-task");

    assert.throws(() => sealPlan(db, started.run.id, config, {
      executionSettings: {
        host: "claude",
        model: "approved-model",
        requestedEffort: "high",
        confirmed: true,
        evidence: "Unit fixture approval",
        tasks: [
          { taskId: "rollback-task", model: "approved-model", requestedEffort: "high", confirmed: true },
          { taskId: "rollback-task-two", model: "approved-model", requestedEffort: "high", confirmed: true }
        ]
      }
    }), /cycle/i);

    const after = db.prepare(`SELECT id, selected_model, requested_effort, effective_effort,
      effort_source, supported_efforts_json, capability_status, reasoning_effort
      FROM tasks WHERE run_id = ? ORDER BY id`).all(started.run.id);
    assert.deepEqual(after, before);
  } finally {
    db.close();
  }
});
