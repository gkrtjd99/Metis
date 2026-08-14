import { MetisError, invariant } from "./errors.js";
import { appendJournal } from "./journal.js";
import { now, parseJson } from "./util.js";

// Reasoning effort is a token-cost guardrail, not a routing decision.  These
// conservative factors model the additional reasoning/output allowance that
// a host may consume for an otherwise identical task.  Input is unchanged;
// the extra budget is attributed to output/reasoning tokens.
export const EFFORT_TOKEN_MULTIPLIERS = Object.freeze({
  low: 0.75,
  medium: 1,
  high: 1.35,
  xhigh: 1.75,
  max: 2.25
});

export function effortTokenMultiplier(effort) {
  const value = String(effort ?? "medium").toLowerCase();
  return EFFORT_TOKEN_MULTIPLIERS[value] ?? EFFORT_TOKEN_MULTIPLIERS.medium;
}

export function estimateEffortTokens(tokens, effort = "medium") {
  const base = Number(tokens);
  invariant(Number.isFinite(base) && base >= 0, "BUDGET_ESTIMATE_INVALID", "Token estimates must be non-negative numbers.");
  return Math.ceil(base * effortTokenMultiplier(effort));
}

export function estimateEffortUsage(inputTokens = 0, outputTokens = 0, effort = "medium") {
  const input = Number(inputTokens);
  const output = Number(outputTokens);
  invariant(Number.isFinite(input) && input >= 0, "BUDGET_ESTIMATE_INVALID", "Input token estimates must be non-negative numbers.");
  invariant(Number.isFinite(output) && output >= 0, "BUDGET_ESTIMATE_INVALID", "Output token estimates must be non-negative numbers.");
  const estimatedOutputTokens = estimateEffortTokens(output, effort);
  return {
    effort: String(effort ?? "medium").toLowerCase(),
    multiplier: effortTokenMultiplier(effort),
    inputTokens: Math.ceil(input),
    outputTokens: estimatedOutputTokens,
    totalTokens: Math.ceil(input) + estimatedOutputTokens
  };
}

function nullableLimit(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
}

export function initializeBudget(db, runId, config) {
  const limits = config.budgets?.run ?? {};
  const timestamp = now();
  db.prepare(`
    INSERT INTO budget_state(
      run_id, input_token_limit, output_token_limit, tool_call_limit,
      agent_spawn_limit, research_call_limit, wall_clock_limit_ms, retry_limit,
      updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO NOTHING
  `).run(
    runId,
    nullableLimit(limits.inputTokens),
    nullableLimit(limits.outputTokens),
    nullableLimit(limits.toolCalls),
    nullableLimit(limits.agentSpawns),
    nullableLimit(limits.researchCalls),
    nullableLimit(Number(limits.wallClockMinutes) * 60 * 1000),
    nullableLimit(limits.retries),
    timestamp
  );
  return budgetStatus(db, runId);
}

function remaining(limit, used) {
  return limit === null || limit === undefined ? null : Math.max(0, Number(limit) - Number(used));
}

function exceeded(limit, used) {
  return limit !== null && limit !== undefined && Number(used) > Number(limit);
}

function schedulerReservations(db, runId) {
  const rows = db.prepare(`
    SELECT id, claimed_task_ids_json, batch_json
    FROM scheduler_batches
    WHERE run_id = ? AND status IN ('claimed','prepared','partially-spawned','spawned')
  `).all(runId);
  const acknowledged = new Set(db.prepare(`
    SELECT batch_id, task_id FROM task_spawn_acks
    WHERE batch_id IN (
      SELECT id FROM scheduler_batches
      WHERE run_id = ? AND status IN ('claimed','prepared','partially-spawned','spawned')
    )
  `).all(runId).map((row) => `${row.batch_id}:${row.task_id}`));
  let agentSpawns = 0;
  let researchCalls = 0;
  for (const row of rows) {
    const batch = new Map(parseJson(row.batch_json, []).map((item) => [item.taskId, item]));
    for (const taskId of parseJson(row.claimed_task_ids_json, [])) {
      if (acknowledged.has(`${row.id}:${taskId}`)) continue;
      agentSpawns += 1;
      if (batch.get(taskId)?.role === "researcher") researchCalls += 1;
    }
  }
  return { agentSpawns, researchCalls };
}

function effortBaseline(db, runId, options = {}) {
  const samples = db.prepare(`
    SELECT observed_input_tokens, observed_output_tokens
    FROM usage_samples
    WHERE run_id = ? AND (observed_input_tokens > 0 OR observed_output_tokens > 0)
    ORDER BY created_at DESC LIMIT 20
  `).all(runId);
  const average = (field) => {
    const values = samples.map((row) => Number(row[field])).filter((value) => Number.isFinite(value) && value > 0);
    return values.length ? Math.ceil(values.reduce((sum, value) => sum + value, 0) / values.length) : 0;
  };
  return {
    inputTokens: Math.max(0, Math.ceil(Number(options.estimatedInputTokens ?? average("observed_input_tokens")) || 0)),
    outputTokens: Math.max(0, Math.ceil(Number(options.estimatedOutputTokens ?? average("observed_output_tokens")) || 0))
  };
}

function effortAwareStatus(db, runId, limits, remainingBudget, options = {}) {
  const baseline = effortBaseline(db, runId, options);
  const projections = Object.fromEntries(Object.keys(EFFORT_TOKEN_MULTIPLIERS).map((effort) => {
    const estimate = estimateEffortUsage(baseline.inputTokens, baseline.outputTokens, effort);
    const unavailable = [];
    if (remainingBudget.inputTokens !== null && estimate.inputTokens > remainingBudget.inputTokens) unavailable.push("inputTokens");
    if (remainingBudget.outputTokens !== null && estimate.outputTokens > remainingBudget.outputTokens) unavailable.push("outputTokens");
    return [effort, {
      ...estimate,
      fitsHardBudget: unavailable.length === 0,
      unavailable
    }];
  }));
  return {
    multipliers: { ...EFFORT_TOKEN_MULTIPLIERS },
    baseline,
    projections
  };
}

export function budgetStatus(db, runId, options = {}) {
  const row = db.prepare("SELECT * FROM budget_state WHERE run_id = ?").get(runId);
  invariant(row, "BUDGET_NOT_INITIALIZED", `Budget state for ${runId} is missing.`);
  const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(runId);
  invariant(run, "RUN_NOT_FOUND", `Run ${runId} was not found.`);
  const elapsedMs = Math.max(0, Date.now() - new Date(run.created_at).getTime());
  const usage = {
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    toolCalls: Number(row.tool_calls),
    agentSpawns: Number(row.agent_spawns),
    researchCalls: Number(row.research_calls),
    retries: Number(row.retries),
    wallClockMs: elapsedMs
  };
  const limits = {
    inputTokens: row.input_token_limit === null ? null : Number(row.input_token_limit),
    outputTokens: row.output_token_limit === null ? null : Number(row.output_token_limit),
    toolCalls: row.tool_call_limit === null ? null : Number(row.tool_call_limit),
    agentSpawns: row.agent_spawn_limit === null ? null : Number(row.agent_spawn_limit),
    researchCalls: row.research_call_limit === null ? null : Number(row.research_call_limit),
    retries: row.retry_limit === null ? null : Number(row.retry_limit),
    wallClockMs: row.wall_clock_limit_ms === null ? null : Number(row.wall_clock_limit_ms)
  };
  const reservations = schedulerReservations(db, runId);
  const remainingBudget = Object.fromEntries(
    Object.keys(usage).map((key) => [key, remaining(limits[key], usage[key] + Number(reservations[key] ?? 0))])
  );
  const exceededKeys = [...new Set([
    ...Object.keys(usage).filter((key) => exceeded(limits[key], usage[key])),
    ...Object.keys(reservations).filter((key) => exceeded(limits[key], usage[key] + Number(reservations[key] ?? 0)))
  ])];
  const effortAware = effortAwareStatus(db, runId, limits, remainingBudget, options);
  return {
    runId,
    usage,
    reservations,
    limits,
    remaining: remainingBudget,
    exceeded: exceededKeys,
    effortAware,
    pass: exceededKeys.length === 0
  };
}

const COUNTER_COLUMNS = Object.freeze({
  inputTokens: "input_tokens",
  outputTokens: "output_tokens",
  toolCalls: "tool_calls",
  agentSpawns: "agent_spawns",
  researchCalls: "research_calls",
  retries: "retries"
});

export function consumeBudget(db, runId, input, options = {}) {
  const entries = Object.entries(input ?? {}).filter(([key, value]) => Object.hasOwn(COUNTER_COLUMNS, key) && Number(value) !== 0);
  invariant(entries.length > 0, "BUDGET_USAGE_REQUIRED", "Provide at least one budget counter.");
  const before = budgetStatus(db, runId);
  const updates = [];
  const values = [];
  for (const [key, rawValue] of entries) {
    const value = Number(rawValue);
    invariant(Number.isFinite(value) && value >= 0, "BUDGET_USAGE_INVALID", `${key} must be a non-negative number.`);
    updates.push(`${COUNTER_COLUMNS[key]} = ${COUNTER_COLUMNS[key]} + ?`);
    values.push(Math.floor(value));
  }
  values.push(now(), runId);
  db.prepare(`UPDATE budget_state SET ${updates.join(", ")}, updated_at = ? WHERE run_id = ?`).run(...values);
  const after = budgetStatus(db, runId);
  appendJournal(db, runId, "budget.consumed", {
    counters: Object.fromEntries(entries),
    source: options.source ?? "runtime",
    exceeded: after.exceeded
  }, { entityType: "budget", entityId: runId });
  if (!after.pass && options.failClosed) {
    throw new MetisError("BUDGET_EXCEEDED", `Run budget exceeded: ${after.exceeded.join(", ")}.`, { before, after });
  }
  db.prepare("UPDATE runs SET updated_at = ?, revision = revision + 1 WHERE id = ?").run(now(), runId);
  return after;
}

export function assertBudgetAvailable(db, runId, requested = {}, options = {}) {
  const status = budgetStatus(db, runId, options);
  const unavailable = [];
  for (const [key, amount] of Object.entries(requested)) {
    if (!Object.hasOwn(status.remaining, key)) continue;
    const left = status.remaining[key];
    if (left !== null && left < Number(amount)) unavailable.push({ key, requested: Number(amount), remaining: left });
  }
  let effortEstimate = null;
  if (options.effort) {
    const baseline = status.effortAware.baseline;
    effortEstimate = estimateEffortUsage(
      options.estimatedInputTokens ?? baseline.inputTokens,
      options.estimatedOutputTokens ?? baseline.outputTokens,
      options.effort
    );
    for (const key of ["inputTokens", "outputTokens"]) {
      const left = status.remaining[key];
      const estimate = effortEstimate[key];
      if (left !== null && left < estimate && !unavailable.some((item) => item.key === key)) {
        unavailable.push({ key, requested: estimate, remaining: left, effort: effortEstimate.effort });
      }
    }
    // A max attempt is rejected before it starts when the estimate cannot fit
    // the hard run budget.  Persist a warning so reports explain the decision.
    if (String(options.effort).toLowerCase() === "max" && unavailable.some((item) => ["inputTokens", "outputTokens"].includes(item.key))) {
      appendJournal(db, runId, "budget.effort-warning", {
        effort: effortEstimate.effort,
        estimate: effortEstimate,
        unavailable,
        reason: "max-attempt-would-exceed-hard-budget"
      }, { entityType: "budget", entityId: runId });
    }
  }
  if (!status.pass || unavailable.length > 0) {
    throw new MetisError("BUDGET_EXCEEDED", "The run does not have enough remaining budget.", {
      exceeded: status.exceeded,
      unavailable,
      effortEstimate,
      status
    });
  }
  return status;
}
