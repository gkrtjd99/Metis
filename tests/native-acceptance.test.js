import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { assertAcceptanceDescriptor, offlineValidation, runAcceptance } from "../scripts/test-native-acceptance.mjs";

function fixtureProvider({ answer = 42, fixedVerdict = false } = {}) {
  const calls = [];
  const provider = async ({ name, prompt }) => {
    const role = name.includes("worker") ? "worker" : "verifier";
    if (role === "worker") assert.match(prompt, /Use ES module syntax, not CommonJS/u);
    else assert.doesNotMatch(prompt, /["']?passed["']?\s*:\s*true/u);
    calls.push(role);
    return {
      receipt: { observed: { sessionId: `offline-fixture-${role}` }, fixture: true },
      structured: role === "worker"
        ? { status: "ok", role, source_text: `export const answer = ${answer};\n`, tools_used: false }
        : fixedVerdict ? { status: "ok", role, passed: true, tools_used: false }
          : { status: "ok", role, observed_answer: answer, syntax_ok: true, tools_used: false }
    };
  };
  return { provider, calls };
}

test("native acceptance 판정기의 기본 부정 사례", () => {
  const report = offlineValidation();
  assert.equal(report.status, "validated");
  assert.equal(report.networkAttempted, false);
  assert.ok(Object.values(report.checks).every(Boolean));
});

test("인수 실행기 전체 공개 CLI 경로를 offline child fixture로 검증한다", async () => {
  const fixture = fixtureProvider();
  const report = await runAcceptance(fixture);
  assert.equal(report.status, "validated", report.error?.code);
  assert.equal(report.terminalType, "COMPLETE");
  assert.equal(report.nativeChildren, false);
  assert.equal(report.conclusion, "offline-fixture-only");
  assert.equal(report.resume.workerCompletion.sameRun, true);
  assert.deepEqual(fixture.calls, ["worker", "verifier"]);
});

test("같은 인수 실행기가 실제 41 산출물은 완료시키지 않는다", async () => {
  const fixture = fixtureProvider({ answer: 41 });
  const report = await runAcceptance(fixture);
  assert.equal(report.status, "failed");
  assert.equal(report.error.code, "worker-candidate-failed");
  assert.deepEqual(fixture.calls, ["worker"]);
  assert.notEqual(report.terminalType, "COMPLETE");
});

test("실제 파일 관측 없이 고정 성공을 반환한 verifier는 거부한다", async () => {
  const fixture = fixtureProvider({ fixedVerdict: true });
  const report = await runAcceptance(fixture);
  assert.equal(report.status, "failed");
  assert.equal(report.error.code, "verifier-observation-mismatch");
  assert.deepEqual(fixture.calls, ["worker", "verifier"]);
  assert.notEqual(report.terminalType, "COMPLETE");
});

test("Codex route delivers the actual descriptor fields to both children", async () => {
  const descriptors = [];
  const provider = async ({ name, descriptor }) => {
    descriptors.push({ name, descriptor });
    const role = name.includes("worker") ? "worker" : "verifier";
    return {
      receipt: { observed: { sessionId: `offline-codex-${role}` }, fixture: true },
      structured: role === "worker"
        ? { status: "ok", role, source_text: "export const answer = 42;\n", tools_used: false }
        : { status: "ok", role, observed_answer: 42, syntax_ok: true, tools_used: false }
    };
  };
  const report = await runAcceptance({
    host: "codex",
    model: "gpt-5.6-luna",
    requestedEffort: "medium",
    capabilities: { "gpt-5.6-luna": ["low", "medium", "high", "xhigh", "max"] },
    provider
  });
  assert.equal(report.status, "validated", report.error?.code);
  assert.equal(descriptors.length, 2);
  for (const { descriptor } of descriptors) {
    assert.equal(descriptor.host, "codex");
    assert.equal(descriptor.model, "gpt-5.6-luna");
    assert.equal(descriptor.requested_effort, "medium");
    assert.equal(descriptor.effective_effort, "medium");
    assert.equal(descriptor.reasoning_effort, "medium");
    assert.equal(descriptor.effort_delivery, "field");
    assert.equal(descriptor.effort_launch_ready, true);
    assert.equal("command" in descriptor, false);
    assert.equal("args" in descriptor, false);
  }
});

test("strict route guards reject missing or false exact-effort claims", () => {
  const codex = {
    host: "codex", model: "gpt-5.6-luna", requested_effort: "medium",
    effective_effort: "medium", reasoning_effort: "medium", effort_delivery: "field",
    effort_exact_required: true, effort_launch_ready: true
  };
  assert.doesNotThrow(() => assertAcceptanceDescriptor(codex, {
    host: "codex", model: "gpt-5.6-luna", requestedEffort: "medium"
  }));
  for (const field of ["effort_exact_required", "effort_launch_ready"]) {
    const mutated = { ...codex, [field]: false };
    assert.throws(
      () => assertAcceptanceDescriptor(mutated, { host: "codex", model: "gpt-5.6-luna", requestedEffort: "medium" }),
      (error) => error.code === "child-route-mismatch"
    );
    const missing = { ...codex };
    delete missing[field];
    assert.throws(
      () => assertAcceptanceDescriptor(missing, { host: "codex", model: "gpt-5.6-luna", requestedEffort: "medium" }),
      (error) => error.code === "child-route-mismatch"
    );
  }
});

test("Codex route mutation is rejected before a child can complete", async () => {
  const calls = [];
  const provider = async ({ name }) => {
    calls.push(name);
    throw new Error("provider should not be called for an unlaunchable route");
  };
  const report = await runAcceptance({
    host: "codex",
    model: "gpt-5.6-luna",
    requestedEffort: "medium",
    capabilities: { "gpt-5.6-luna": ["low"] },
    provider
  });
  assert.equal(report.status, "failed");
  assert.equal(report.error.code, "plan-materialization-unexpected");
  assert.deepEqual(calls, []);
});

test("명시 opt-in 없는 인수 실행기는 provider를 호출하지 않는다", () => {
  const child = spawnSync(process.execPath, ["scripts/test-native-acceptance.mjs"], {
    encoding: "utf8", timeout: 10000, env: { PATH: "" }
  });
  assert.equal(child.status, 0);
  assert.equal(JSON.parse(child.stdout).networkAttempted, false);
});
