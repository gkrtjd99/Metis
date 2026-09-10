import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { memoryMatches, isTextDelta, isCompactBoundary } from "../scripts/test-native-session-recovery.mjs";

test("compact 성공 문장이 아니라 host compact boundary를 요구한다", () => {
  assert.equal(isCompactBoundary({ type: "result", result: "compact success" }), false);
  assert.equal(isCompactBoundary({ type: "system", subtype: "compact_boundary" }), false);
  assert.equal(isCompactBoundary({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto" } }), false);
  assert.equal(isCompactBoundary({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual" } }), true);
});

test("session 복원은 목표·값·제약을 모두 원문대로 유지해야 한다", () => {
  const expected = { goal_id: "opaque-goal", answer: 42, constraint: "opaque-constraint" };
  const actual = { ...expected, status: "ok", tools_used: false };
  assert.equal(memoryMatches(actual, expected), true);
  for (const change of [{ goal_id: "other" }, { answer: 41 }, { constraint: "other" }, { tools_used: true }, { status: "failed" }]) {
    assert.equal(memoryMatches({ ...actual, ...change }, expected), false);
  }
  assert.equal(memoryMatches(null, expected), false);
});

test("강제 종료 시점은 init이나 완료가 아니라 실제 text delta여야 한다", () => {
  assert.equal(isTextDelta({ type: "system", subtype: "init" }), false);
  assert.equal(isTextDelta({ type: "result" }), false);
  assert.equal(isTextDelta({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "1" } } }), true);
  assert.equal(isTextDelta({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "1" } } }), false);
});

test("session 복원 probe는 명시 opt-in 없이는 provider를 실행하지 않는다", () => {
  const child = spawnSync(process.execPath, ["scripts/test-native-session-recovery.mjs"], {
    encoding: "utf8", timeout: 10000, env: { PATH: "" }
  });
  assert.equal(child.status, 0);
  assert.equal(JSON.parse(child.stdout).networkAttempted, false);
});
