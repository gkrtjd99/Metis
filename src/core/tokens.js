import { spawnSync } from "node:child_process";
import { invariant } from "./errors.js";
import { consumeBudget, estimateEffortTokens, estimateEffortUsage, effortTokenMultiplier } from "./budget.js";
import { json, makeId, now, sha256 } from "./util.js";

function classifyCodePoint(char) {
  const code = char.codePointAt(0);
  if (/\s/u.test(char)) return "space";
  if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(char)) return "cjk";
  if (/\p{Letter}|\p{Number}/u.test(char)) return code < 128 ? "asciiWord" : "word";
  if (/\p{Extended_Pictographic}/u.test(char)) return "emoji";
  return "punctuation";
}

/**
 * A Unicode-aware fallback. It is intentionally conservative for code, JSON, CJK, and emoji.
 * Exact counts come from an external tokenizer or host-observed usage when available.
 */
export function estimateTokens(text) {
  const value = String(text ?? "");
  if (!value) return 0;
  let tokens = 0;
  let runType = null;
  let runLength = 0;
  const flush = () => {
    if (!runType || runLength === 0) return;
    if (runType === "asciiWord") tokens += Math.ceil(runLength / 3.7);
    else if (runType === "word") tokens += Math.ceil(runLength / 2.2);
    else if (runType === "cjk") tokens += Math.ceil(runLength * 0.95);
    else if (runType === "emoji") tokens += Math.ceil(runLength * 2.1);
    else if (runType === "punctuation") tokens += Math.ceil(runLength / 1.7);
    runType = null;
    runLength = 0;
  };
  for (const char of value) {
    const type = classifyCodePoint(char);
    if (type === "space") {
      flush();
      continue;
    }
    if (type !== runType) flush();
    runType = type;
    runLength += 1;
  }
  flush();
  const linePenalty = Math.ceil((value.match(/\n/g)?.length ?? 0) / 8);
  return Math.max(1, Math.ceil(tokens + linePenalty));
}

function calibrationFactor(db, model) {
  if (!db) return 1;
  const rows = model
    ? db.prepare(`
        SELECT estimated_tokens, observed_input_tokens
        FROM usage_samples
        WHERE model = ? AND estimated_tokens > 0 AND observed_input_tokens > 0
        ORDER BY created_at DESC LIMIT 50
      `).all(model)
    : db.prepare(`
        SELECT estimated_tokens, observed_input_tokens
        FROM usage_samples
        WHERE estimated_tokens > 0 AND observed_input_tokens > 0
        ORDER BY created_at DESC LIMIT 50
      `).all();
  if (rows.length < 3) return 1;
  const estimated = rows.reduce((sum, row) => sum + Number(row.estimated_tokens), 0);
  const observed = rows.reduce((sum, row) => sum + Number(row.observed_input_tokens), 0);
  if (estimated <= 0 || observed <= 0) return 1;
  return Math.min(2.5, Math.max(0.4, observed / estimated));
}

function externalTokenCount(text, model, tokenizer) {
  if (!tokenizer?.command) return null;
  const args = (tokenizer.args ?? []).map((arg) => String(arg).replaceAll("{model}", model ?? ""));
  const result = spawnSync(tokenizer.command, args, {
    input: String(text),
    encoding: "utf8",
    timeout: tokenizer.timeoutMs ?? 5000,
    maxBuffer: 16 * 1024 * 1024,
    shell: false
  });
  if (result.status !== 0) return null;
  const output = String(result.stdout ?? "").trim();
  if (!output) return null;
  const direct = Number(output);
  if (Number.isInteger(direct) && direct >= 0) return direct;
  try {
    const parsed = JSON.parse(output);
    const count = Number(parsed.tokens ?? parsed.count ?? parsed.input_tokens);
    return Number.isInteger(count) && count >= 0 ? count : null;
  } catch {
    return null;
  }
}

export function countTokens(db, text, options = {}) {
  const observed = Number(options.observedTokens);
  if (Number.isInteger(observed) && observed >= 0) {
    return { tokens: observed, method: "host-observed", estimatedTokens: estimateTokens(text), calibrationFactor: 1 };
  }
  const model = options.model ?? null;
  const tokenizer = options.config?.budgets?.tokenizer ?? null;
  if (tokenizer?.mode !== "estimate") {
    const exact = externalTokenCount(text, model, tokenizer);
    if (exact !== null) return { tokens: exact, method: "external-tokenizer", estimatedTokens: exact, calibrationFactor: 1 };
  }
  const raw = estimateTokens(text);
  const factor = calibrationFactor(db, model);
  return {
    tokens: Math.max(1, Math.ceil(raw * factor)),
    method: factor === 1 ? "unicode-estimate" : "calibrated-estimate",
    estimatedTokens: raw,
    calibrationFactor: Number(factor.toFixed(4))
  };
}

/**
 * Estimate the token envelope for an attempt at a selected reasoning effort.
 * Host-observed usage remains authoritative; this helper is intentionally
 * marked as an estimate so it can be used for pre-spawn hard-budget guards.
 */
export function estimateAttemptTokens(db, text, options = {}) {
  const measured = countTokens(db, text, options);
  const outputBaseline = Number(options.outputTokens ?? options.expectedOutputTokens ?? measured.tokens);
  const usage = estimateEffortUsage(measured.tokens, outputBaseline, options.effort ?? "medium");
  return {
    ...usage,
    inputMethod: measured.method,
    estimatedInputTokens: measured.tokens,
    estimatedOutputTokens: usage.outputTokens,
    calibrationFactor: measured.calibrationFactor,
    effortMultiplier: effortTokenMultiplier(options.effort ?? "medium")
  };
}

export { estimateEffortTokens, estimateEffortUsage, effortTokenMultiplier };

export function effectiveContextBudget(config, requested = null, remainingTokens = null) {
  const configured = Number(requested ?? config.budgets.mainContextTokens);
  invariant(Number.isInteger(configured) && configured > 0, "TOKEN_BUDGET", "Context token budget must be a positive integer.");
  const remaining = Number(remainingTokens);
  if (!Number.isInteger(remaining) || remaining <= 0) return configured;
  const reserve = Math.max(0, Number(config.budgets.reserveTokens ?? 0));
  const fraction = Math.min(0.5, Math.max(0.05, Number(config.budgets.maxRemainingFraction ?? 0.18)));
  const fractionBudget = Math.floor(remaining * fraction);
  const reserveBudget = Math.max(400, remaining - reserve);
  return Math.max(400, Math.min(configured, fractionBudget, reserveBudget));
}

export function recordUsageSample(db, runId, input) {
  const observedInput = Number(input.observedInputTokens ?? input.inputTokens ?? input.input_tokens);
  const observedOutput = Number(input.observedOutputTokens ?? input.outputTokens ?? input.output_tokens ?? 0);
  invariant(Number.isInteger(observedInput) && observedInput >= 0, "USAGE_INPUT_TOKENS", "Observed input tokens must be a non-negative integer.");
  invariant(Number.isInteger(observedOutput) && observedOutput >= 0, "USAGE_OUTPUT_TOKENS", "Observed output tokens must be a non-negative integer.");
  const content = input.content ?? null;
  const estimated = input.estimatedTokens === undefined
    ? (content === null ? null : estimateTokens(content))
    : Number(input.estimatedTokens);
  const id = input.id ?? makeId("usage");
  db.prepare(`
    INSERT INTO usage_samples(
      id, run_id, role, model, content_hash, estimated_tokens,
      observed_input_tokens, observed_output_tokens, source, metadata_json, created_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    runId ?? null,
    String(input.role ?? "main"),
    input.model ?? null,
    input.contentHash ?? (content === null ? null : sha256(String(content))),
    Number.isFinite(estimated) ? Math.max(0, Math.round(estimated)) : null,
    observedInput,
    observedOutput,
    String(input.source ?? "host"),
    json(input.metadata ?? {}),
    now()
  );
  if (runId && (observedInput > 0 || observedOutput > 0)) {
    consumeBudget(db, runId, {
      ...(observedInput > 0 ? { inputTokens: observedInput } : {}),
      ...(observedOutput > 0 ? { outputTokens: observedOutput } : {})
    }, { source: `usage:${String(input.source ?? "host")}` });
  }
  return db.prepare("SELECT * FROM usage_samples WHERE id = ?").get(id);
}

export function usageCalibration(db, model = null) {
  return { model, factor: Number(calibrationFactor(db, model).toFixed(4)) };
}
