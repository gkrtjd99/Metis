import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { collectClaudeReceipt, runChild, validateClaudeReceipt } from "../scripts/test-native-effort-delivery.mjs";

function execution(overrides = {}) {
  return { exitCode: 0, signal: null, timedOut: false, ...overrides };
}

function rawPath() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "metis-native-unit-"));
  return { directory, file: path.join(directory, "raw.log") };
}

function receipt(body = "{\"status\":\"ok\",\"model\":\"unknown\",\"effort\":\"unknown\",\"tools_used\":false}", extra = "") {
  return collectClaudeReceipt([
    JSON.stringify({ type: "system", model: "gpt-5.6-luna", session_id: "session-local" }),
    JSON.stringify({ type: "result", result: body }),
    extra
  ].filter(Boolean).join("\n"), "");
}

test("유효 receipt는 transport 검증만 통과시키고 모델/effort 확인과 분리한다", () => {
  const parsed = receipt();
  const result = validateClaudeReceipt(parsed, execution(), { model: "sonnet", effort: "medium" });
  assert.equal(result.valid, true);
  assert.equal(result.conclusion, "transport-validated-only");
  assert.equal(result.model_confirmation, "mismatch-unconfirmed");
  assert.equal(result.effort_confirmation, "unconfirmed");
});

test("예상외 text가 섞인 exit 0은 fail closed 한다", () => {
  const parsed = collectClaudeReceipt(`unexpected text\n${JSON.stringify({ type: "system", model: "sonnet", session_id: "session-local" })}\n${JSON.stringify({ type: "result", result: '{"status":"ok","tools_used":false}' })}`, "");
  const result = validateClaudeReceipt(parsed, execution(), { model: "sonnet", effort: "medium" });
  assert.equal(result.valid, false);
  assert.equal(result.checks.noUnexpectedText, false);
});

test("session receipt 누락은 exit 0이어도 실패한다", () => {
  const parsed = collectClaudeReceipt(JSON.stringify({ type: "result", result: '{"status":"ok","tools_used":false}' }), "");
  const result = validateClaudeReceipt(parsed, execution());
  assert.equal(result.valid, false);
  assert.equal(result.checks.session, false);
});

test("assistant text만 있고 terminal result event가 없으면 실패한다", () => {
  const parsed = collectClaudeReceipt(JSON.stringify({
    type: "assistant", model: "sonnet", session_id: "session-local",
    message: { content: [{ type: "text", text: '{"status":"ok","tools_used":false}' }] }
  }), "");
  const result = validateClaudeReceipt(parsed, execution());
  assert.equal(result.valid, false);
  assert.equal(result.checks.terminalResult, false);
});

test("result.permission_denials와 permission event는 모두 실패시킨다", () => {
  const parsed = collectClaudeReceipt([
    JSON.stringify({ type: "system", model: "sonnet", session_id: "session-local" }),
    JSON.stringify({ type: "result", permission_denials: ["Read"], result: '{"status":"ok","tools_used":false}' }),
    JSON.stringify({ type: "permission_denial", tool_name: "Bash" })
  ].join("\n"), "");
  const result = validateClaudeReceipt(parsed, execution());
  assert.deepEqual(parsed.permissionDenials, ["Read", "Bash"]);
  assert.equal(result.valid, false);
  assert.equal(result.checks.noPermissionDenials, false);
});

test("fake error event와 invalid structured response는 성공으로 승격하지 않는다", () => {
  const parsed = collectClaudeReceipt([
    JSON.stringify({ type: "system", model: "sonnet", session_id: "session-local" }),
    JSON.stringify({ type: "error", message: "secret provider detail" }),
    JSON.stringify({ type: "result", result: "not-json" })
  ].join("\n"), "");
  const result = validateClaudeReceipt(parsed, execution());
  assert.equal(result.valid, false);
  assert.equal(result.checks.noProviderError, false);
  assert.equal(result.checks.structured, false);
  assert.equal(parsed.errors[0], "provider-error");
});

test("tool_use event는 tools_used false 응답과 함께 있어도 실패한다", () => {
  const parsed = receipt(undefined, JSON.stringify({ type: "tool_use", name: "Read" }));
  const result = validateClaudeReceipt(parsed, execution());
  assert.equal(result.valid, false);
  assert.equal(result.checks.noTools, false);
});

test("잘린 output과 spawn error는 exit 0처럼 보여도 실패한다", () => {
  const truncated = validateClaudeReceipt(receipt(), execution({ outputTruncated: true }));
  assert.equal(truncated.valid, false);
  assert.equal(truncated.checks.outputComplete, false);
  const spawned = validateClaudeReceipt(receipt(), execution({ error: "spawn-error" }));
  assert.equal(spawned.valid, false);
  assert.equal(spawned.checks.noSpawnError, false);
});

test("nonzero exit는 구조화 응답이 있어도 실패한다", () => {
  const result = validateClaudeReceipt(receipt(), execution({ exitCode: 1 }));
  assert.equal(result.valid, false);
  assert.equal(result.checks.exitZero, false);
});

test("child output은 bounded raw receipt로 잘리고 SIGTERM 불응시 SIGKILL fallback을 사용한다", async () => {
  const { directory, file } = rawPath();
  try {
    const large = await runChild(process.execPath, ["-e", "process.stdout.write('x'.repeat(300000))"], "", file, { timeoutMs: 1_000, maxOutputBytes: 1_024 });
    assert.equal(large.exitCode, 0);
    assert.equal(large.outputTruncated, true);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(readFileSync(file).length, 1_024);

    const ignoresTerm = await runChild(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], "", file, { timeoutMs: 1_500, maxOutputBytes: 1_024 });
    assert.equal(ignoresTerm.timedOut, true);
    assert.equal(ignoresTerm.forceKilled, true);
    assert.equal(ignoresTerm.signal, "SIGKILL");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("실패 report는 completed로 위장하지 않고 process exit 1을 반환한다", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "metis-native-fake-cli-"));
  const fake = path.join(directory, "claude");
  // provider 네트워크 대신 fake CLI를 사용해 실패 exit semantics만 검증한다.
  writeFileSync(fake, "#!/bin/sh\nif [ \"$1\" = \"--help\" ]; then printf '%s\\n' '--effort <level>'; exit 0; fi\nprintf '%s\\n' '{\"type\":\"result\",\"result\":\"{\\\"status\\\":\\\"ok\\\",\\\"tools_used\\\":false}\"}'; exit 0\n");
  chmodSync(fake, 0o700);
  try {
    const script = path.resolve("scripts/test-native-effort-delivery.mjs");
    const result = spawnSync(process.execPath, [script, "--run", "--provider", "claude", "--json"], {
      encoding: "utf8", env: { PATH: directory }
    });
    const report = JSON.parse(result.stdout);
    assert.equal(result.status, 1);
    assert.equal(report.status, "failed");
    assert.equal(report.providers[0].status, "failed");
    assert.equal(report.providers[0].error_code, "missing-session-receipt");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("스크립트 help와 opt-in 전 기본 경계는 provider를 실행하지 않는다", () => {
  const script = path.resolve("scripts/test-native-effort-delivery.mjs");
  const result = spawnSync(process.execPath, [script, "--json"], { encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).status, "opt-in-required");
});
