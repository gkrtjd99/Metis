import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  REQUESTED_EFFORT,
  REQUESTED_MODEL,
  codexArgs,
  collectCodexReceipt,
  lunaEvidence,
  offlineValidation,
  validateCodexReceipt
} from "../scripts/test-native-codex-acceptance.mjs";

test("Codex acceptance offline negative checks pass without network", () => {
  const report = offlineValidation();
  assert.equal(report.status, "validated");
  assert.equal(report.networkAttempted, false);
  assert.ok(Object.values(report.checks).every(Boolean));
});

test("Codex invocation carries concrete Luna and medium effort safely", () => {
  const args = codexArgs();
  assert.deepEqual(args.slice(0, 5), ["exec", "--ephemeral", "--ignore-user-config", "--model", REQUESTED_MODEL]);
  assert.ok(args.includes(`model_reasoning_effort=\"${REQUESTED_EFFORT}\"`));
  assert.ok(args.includes("--sandbox"));
  assert.ok(args.includes("read-only"));
  assert.ok(args.includes("--json"));
  assert.equal(args.at(-1), "-");
  assert.ok(!args.some((value) => value.includes("dangerously")));
});

test("local catalog evidence requires exact Luna ID and requested effort", () => {
  const evidence = lunaEvidence([
    { slug: "gpt-5.6-luna", display_name: "GPT-5.6-Luna", default_reasoning_level: "medium", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }] },
    { slug: "other-model", supported_reasoning_levels: [{ effort: "high" }] }
  ]);
  assert.equal(evidence.found, true);
  assert.equal(evidence.model.id, REQUESTED_MODEL);
  assert.equal(evidence.model.defaultReasoningLevel, REQUESTED_EFFORT);
  assert.equal(evidence.supportsRequestedEffort, true);
  assert.equal(lunaEvidence([{ slug: "gpt-5.6-luna", supported_reasoning_levels: [{ effort: "low" }] }]).supportsRequestedEffort, false);
});

test("Codex JSONL receipt accepts terminal agent response and tracks thread", () => {
  const receipt = collectCodexReceipt([
    JSON.stringify({ type: "thread.started", thread_id: "thread-worker" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: '{"status":"ok","role":"worker","source_text":"export const answer = 42;\\n","tools_used":false}' } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 4, output_tokens: 5, total_tokens: 9 } })
  ].join("\n"));
  const validation = validateCodexReceipt(receipt, { exitCode: 0, signal: null, timedOut: false, outputTruncated: false }, "worker");
  assert.equal(validation.valid, true);
  assert.equal(receipt.observed.sessionId, "thread-worker");
  assert.equal(receipt.structuredResponse.tools_used, false);
  assert.equal(receipt.usage.totalTokens, 9);
});

test("tool, missing terminal, missing session, and malformed JSON fail closed", () => {
  const toolReceipt = collectCodexReceipt([
    JSON.stringify({ type: "thread.started", thread_id: "thread-tool" }),
    JSON.stringify({ type: "item.completed", item: { type: "command_execution", text: "ran" } }),
    JSON.stringify({ type: "turn.completed" })
  ].join("\n"));
  assert.equal(validateCodexReceipt(toolReceipt, { exitCode: 0, signal: null, timedOut: false, outputTruncated: false }, "worker").valid, false);

  const unknownItems = collectCodexReceipt([
    JSON.stringify({ type: "thread.started", thread_id: "thread-unknown" }),
    JSON.stringify({ type: "item.completed", item: { type: "function_call" } }),
    JSON.stringify({ type: "item.completed", item: { type: "todo_list" } }),
    JSON.stringify({ type: "turn.completed" })
  ].join("\n"));
  assert.deepEqual(unknownItems.unsupportedItems, ["function_call", "todo_list"]);
  assert.equal(validateCodexReceipt(unknownItems, { exitCode: 0, signal: null, timedOut: false, outputTruncated: false }, "worker").valid, false);

  const noTerminal = collectCodexReceipt([
    JSON.stringify({ type: "thread.started", thread_id: "thread-no-terminal" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: '{"status":"ok","role":"worker","tools_used":false}' } })
  ].join("\n"));
  assert.equal(validateCodexReceipt(noTerminal, { exitCode: 0, signal: null, timedOut: false, outputTruncated: false }, "worker").valid, false);

  const malformed = collectCodexReceipt("not-json\n" + JSON.stringify({ type: "turn.completed" }));
  assert.equal(validateCodexReceipt(malformed, { exitCode: 0, signal: null, timedOut: false, outputTruncated: false }, "worker").valid, false);

  const stderr = collectCodexReceipt([
    JSON.stringify({ type: "thread.started", thread_id: "thread-stderr" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: '{"status":"ok","role":"worker","tools_used":false}' } }),
    JSON.stringify({ type: "turn.completed" })
  ].join("\n"), "provider error");
  assert.equal(validateCodexReceipt(stderr, { exitCode: 0, signal: null, timedOut: false, outputTruncated: false }, "worker").valid, false);
});

test("Codex acceptance script is opt-in and does not run provider by default", () => {
  const child = spawnSync(process.execPath, ["scripts/test-native-codex-acceptance.mjs"], {
    encoding: "utf8", timeout: 10_000, env: { PATH: "" }
  });
  assert.equal(child.status, 0);
  const report = JSON.parse(child.stdout);
  assert.equal(report.status, "opt-in-required");
  assert.equal(report.attempted, false);
  assert.equal(report.networkAttempted, false);
});
