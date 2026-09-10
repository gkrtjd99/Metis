import assert from "node:assert/strict";
import test from "node:test";
import { MetisError } from "../src/core/errors.js";
import { parseSkillEntry } from "../src/core/skill-entry.js";

const parsed = (mode, objective = null, documentPath = null) => ({ mode, objective, documentPath });

function assertMetisError(callback, code) {
  assert.throws(callback, (error) => {
    assert.ok(error instanceof MetisError);
    assert.equal(error.code, code);
    return true;
  });
}

test("빈 입력은 status로 해석한다", () => {
  assert.deepEqual(parseSkillEntry("   \n\t"), parsed("status"));
});

test("prd와 plan은 objective를 보존하고 명시적 verb만 인식한다", () => {
  assert.deepEqual(parseSkillEntry("prd Add the release checklist"), parsed("prd", "Add the release checklist"));
  assert.deepEqual(parseSkillEntry("plan \"Keep two  spaces\""), parsed("plan", "Keep two  spaces"));
  assert.deepEqual(parseSkillEntry("\"plan\" the quoted objective"), parsed("execute", "plan the quoted objective"));
  assert.deepEqual(parseSkillEntry("execute this literally"), parsed("execute", "execute this literally"));
});

test("prd와 plan은 @ 문서 경로 및 공백 경로를 지원한다", () => {
  assert.deepEqual(parseSkillEntry("prd @docs/spec.md"), parsed("prd", null, "docs/spec.md"));
  assert.deepEqual(parseSkillEntry('plan @"docs/a b.md"'), parsed("plan", null, "docs/a b.md"));
  assert.deepEqual(parseSkillEntry('prd "@docs/a b.md"'), parsed("prd", null, "docs/a b.md"));
  assert.deepEqual(parseSkillEntry("plan @/absolute/spec.md"), parsed("plan", null, "/absolute/spec.md"));
});

test("unquoted multi-token 문서 경로는 모호성 오류를 낸다", () => {
  assertMetisError(() => parseSkillEntry("prd @docs/a b.md"), "SKILL_ENTRY_DOCUMENT_AMBIGUOUS");
  assertMetisError(() => parseSkillEntry("plan @docs/spec.md extra"), "SKILL_ENTRY_DOCUMENT_AMBIGUOUS");
  assertMetisError(() => parseSkillEntry("prd @"), "SKILL_ENTRY_DOCUMENT_INVALID");
});

test("run, resume, status는 인자를 허용하지 않는다", () => {
  assert.deepEqual(parseSkillEntry("run"), parsed("run"));
  assert.deepEqual(parseSkillEntry("resume"), parsed("resume"));
  assert.deepEqual(parseSkillEntry("status"), parsed("status"));
  assertMetisError(() => parseSkillEntry("run 123"), "SKILL_ENTRY_ARGUMENTS");
  assertMetisError(() => parseSkillEntry("resume --flag"), "SKILL_ENTRY_ARGUMENTS");
  assertMetisError(() => parseSkillEntry("status anything"), "SKILL_ENTRY_ARGUMENTS");
});

test("알 수 없는 입력은 execute objective로 원문을 남긴다", () => {
  assert.deepEqual(parseSkillEntry("Investigate $HOME and $(printf no)"), parsed("execute", "Investigate $HOME and $(printf no)"));
  assert.deepEqual(parseSkillEntry("검색 수정 $(touch should-not-exist); `whoami`"), parsed("execute", "검색 수정 $(touch should-not-exist); `whoami`"));
  assert.deepEqual(parseSkillEntry("don't alter this"), parsed("execute", "don't alter this"));
  assert.deepEqual(parseSkillEntry("$metis:model sonnet"), parsed("execute", "$metis:model sonnet"));
});

test("인용부호와 fence는 닫혀야 한다", () => {
  assert.deepEqual(parseSkillEntry('execute `literal fence`'), parsed("execute", "execute `literal fence`"));
  assert.deepEqual(parseSkillEntry('prd "quoted objective"'), parsed("prd", "quoted objective"));
  assertMetisError(() => parseSkillEntry('prd "unfinished'), "SKILL_ENTRY_MALFORMED");
  assertMetisError(() => parseSkillEntry("plan `unfinished"), "SKILL_ENTRY_MALFORMED");
  assert.deepEqual(parseSkillEntry("plan trailing\\"), parsed("plan", "trailing\\"));
});

test("NUL과 16KiB 초과 입력은 거부한다", () => {
  assertMetisError(() => parseSkillEntry("plan ok\0no"), "SKILL_ENTRY_NUL");
  assert.deepEqual(parseSkillEntry("x".repeat(16 * 1024)), parsed("execute", "x".repeat(16 * 1024)));
  assertMetisError(() => parseSkillEntry("x".repeat(16 * 1024) + "x"), "SKILL_ENTRY_TOO_LARGE");
});
