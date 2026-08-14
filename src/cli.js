#!/usr/bin/env -S node --no-warnings
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync, readSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ensureConfig, loadConfig } from "./core/config.js";
import { openDatabase } from "./core/db.js";
import { MetisError, invariant } from "./core/errors.js";
import {
  activeRun,
  advancePhase,
  blockRun,
  gateReport,
  getArtifact,
  getRun,
  isProtectedLifecycleArtifactKind,
  latestArtifact,
  putArtifact,
  reopenPhase,
  pauseRun,
  resumeRun,
  startRun,
  waiveArtifact
} from "./core/state.js";
import {
  addTask,
  claimTask,
  finishTask,
  getRunnableTasks,
  getTask,
  heartbeatTask,
  listTasks,
  retryTask,
  sealPlan,
  taskContract,
  waiveTask
} from "./core/tasks.js";
import { lintPlan, recordPlanReview } from "./core/plan-review.js";
import { addMilestone, getMilestone, listMilestones } from "./core/milestones.js";
import { renderSpawnDescriptor } from "./adapters/spawn-descriptors.js";
import {
  addDecision,
  addFinding,
  getDecision,
  getFinding,
  listDecisions,
  listFindings,
  setDecisionStatus,
  setFindingStatus
} from "./core/evidence.js";
import { addDocumentImpact, listDocumentImpacts, resolveDocumentImpact } from "./core/docs.js";
import { listChecks, registerCheck, registerDetectedChecks, runChecks } from "./core/checks.js";
import { buildMainContext, compactTaskContract } from "./core/context.js";
import { doctor } from "./core/doctor.js";
import { synchronizeKnowledge } from "./core/knowledge.js";
import { searchProjectKnowledge } from "./core/project-knowledge.js";
import { cleanRuntime, garbageCollect, resetRuntime, tokenMetrics } from "./core/maintenance.js";
import { storageInventory } from "./core/paths.js";
import { recordUsageSample, usageCalibration } from "./core/tokens.js";
import { benchmarkReport, compareBenchmarkVariants, initializeBenchmark, runBenchmark } from "./core/benchmark.js";
import { readObject } from "./core/objects.js";
import { buildReport, performanceReport, reportMarkdown } from "./core/report.js";
import { repositoryCodeFingerprint, syncRepository } from "./core/repository.js";
import { installAdapters, installationInventory, uninstallAdapters } from "./adapters/install.js";
import { readStdin, runCommand, stableStringify } from "./core/util.js";
import { attachProject, resolveProjectRoot, routeLifecycle } from "./core/project-bootstrap.js";
import { driveController, materializeControllerTaskWave, nextControllerAction } from "./core/controller.js";
import {
  amendGoalContract,
  freezeGoalContract,
  getGoalContract,
  listRequirements,
  setRequirementStatus
} from "./core/contracts.js";
import { linkRequirement, listTraceLinks, traceabilityReport } from "./core/traceability.js";
import {
  addAssumption,
  addInvariant,
  addRisk,
  getAssumption,
  getInvariant,
  getRisk,
  governanceReport,
  listAssumptions,
  listInvariants,
  listRisks,
  setAssumptionStatus,
  setInvariantStatus,
  setRiskStatus
} from "./core/governance.js";
import { lintDesign, recordDesignReview, sealDesign } from "./core/design-review.js";
import { abortScheduleBatch, acknowledgeScheduleSpawn, claimSchedule, handleChildTerminal, heartbeatScheduleBatch, proposeSchedule, refreshScheduleBatch } from "./core/scheduler.js";
import {
  getReviewFinding,
  ingestReviewTask,
  listReviewFindings,
  reconcileReview,
  reviewReport,
  setReviewFindingStatus
} from "./core/reviews.js";
import { budgetStatus, consumeBudget } from "./core/budget.js";
import { progressStatus, sampleProgress } from "./core/progress.js";
import { listJournal, replayJournal } from "./core/journal.js";
import { evaluateRun, latestEvaluation } from "./core/evaluation.js";
import { createVerificationCandidate, getVerificationCandidate } from "./core/verification.js";
import { assertController, controllerStatus, heartbeatController, takeoverController } from "./core/ownership.js";
import { addCheckpoint, checkpointStatus, getCheckpoint, listCheckpoints, resolveCheckpoint } from "./core/checkpoints.js";
import { browserStatus, getBrowserScenario, listBrowserScenarios, registerBrowserScenario, runBrowserScenario } from "./core/browser.js";
import { capabilityExplanation, listCapabilities } from "./core/capabilities.js";
import { addInterfaceContract, freezeInterfaceContract, getInterfaceContract, listInterfaceContracts } from "./core/interfaces.js";
import { compileTaskPacket, getTaskPacket, listTaskPackets, taskPacketStatus } from "./core/task-packets.js";
import { currentPlanDraftBinding, ingestPlanDraft } from "./core/plan-ingest.js";
import { configureModels, modelConfigView, resetModels } from "./core/model-config.js";
import { assertSupportedNodeVersion } from "./runtime/node-version.js";

const HELP = `Metis CLI

Managed host entrypoint:
  /goal $metis "<objective>"

Install and controller ownership:
  metis init [--host codex|claude|opencode|all] [--force]
  metis attach [--host codex|claude|opencode|all]
  metis lifecycle
  metis start <goal> [--host codex] [--approval autonomous-local]
  metis controller status
  metis controller heartbeat
  metis controller takeover [--force --yes]
  metis controller materialize [--file file | --data json | stdin]
  metis status [--context] [--markdown]
  metis next [--tokens N] [--remaining-tokens N] [--model model]
  metis drive [--max-iterations N]
  metis context [--tokens N] [--remaining-tokens N] [--observed-tokens N] [--model model]
  metis gate [phase]
  metis advance [phase]
  metis reopen <phase> <reason>
  metis block <reason>
  metis pause <reason>
  metis resume

Goal contract and traceability:
  metis contract freeze [--file file | --data json | stdin]
  metis contract get
  metis contract amend [--file file | --data json | stdin]
  metis requirement list [--status active]
  metis requirement status <id> <active|implemented|verified|waived|superseded> [--evidence json]
  metis requirement link [--file file | --data json | stdin]
  metis trace list [--requirement id]
  metis trace report

Governance:
  metis assumption add|get|list|status ...
  metis invariant add|get|list|status ...
  metis risk add|get|list|status ...
  metis governance report

Artifacts and evidence:
  metis artifact put <kind> [--file file | --data json | stdin]
  metis artifact get <id>
  metis artifact latest <kind>
  metis artifact waive <kind> <reason>
  metis object get <obj_ref> [--out file]
  metis finding add|list|get|status ...
  metis decision add|list|get|status ...

Planning and orchestration:
  metis model show
  metis model configure [--file file | --data json | stdin]
  metis model reset --yes
  metis milestone add|list|get ...
  metis design lint|seal|review ...
  metis plan lint|seal|review|ingest ...
  metis interface add|get|list|freeze ...
  metis task packet compile|get|status|list ...
  metis capability list
  metis capability explain <task-id>
  metis schedule propose [--limit N] [--parent-task id]
  metis schedule claim [--owner name] [--limit N] [--parent-task id]
  metis schedule ack <batch-id> --receipts '{"task-id":{"receipt":"host-child-receipt","batchId":"batch-id","taskId":"task-id","attemptFence":1}}' [--tasks id1,id2] [--owner name]
  metis schedule heartbeat <batch-id>
  metis schedule abort <batch-id> <reason>
  metis schedule child-failure <batch-id> <task-id> --data '{"code":"server_overloaded"}'
  metis schedule status <batch-id>
  metis task add|get|list|runnable|contract|claim|heartbeat|finish|retry|waive ...

Product delivery:
  metis browser add [--file file | --data json | stdin]
  metis browser get|list|status ...
  metis browser run <scenario> [--timeout-ms N]
  metis checkpoint add [--file file | --data json | stdin]
  metis checkpoint get|list|status ...
  metis checkpoint resolve <id> <resolution> [--status resolved|rejected|waived]
  metis uat status

Review and verification:
  metis review ingest <task-id>
  metis review list|get|status|reconcile|report ...
  metis verification candidate
  metis verification get
  metis check detect
  metis check add --name <name> (--command <executable> [--args '<json-array>'] | --command-json '<json>')
  metis check list
  metis check run [--name <name>] [--continue]

Knowledge and documentation:
  metis docs add --path <path> --reason <reason> [--requirements id1,id2]
  metis docs list [--status pending]
  metis docs resolve (--id <id> | --path <path>) [--disposition updated] [--evidence json]
  metis repo sync
  metis knowledge sync
  metis knowledge search <query> [--limit N]

Control, observability, and replay:
  metis budget status
  metis budget consume [--file file | --data json | stdin]
  metis progress sample|status
  metis journal list|replay ...
  metis evaluate
  metis evaluate latest
  metis usage add [--file file | --data json | stdin]
  metis usage calibration [--model model]
  metis metrics
  metis report [--markdown] [--out file]
  metis performance report
  metis doctor

Storage and benchmark:
  metis storage [--installation]
  metis install status
  metis gc [--keep-contexts N] [--dry-run]
  metis clean [--scope cache|generated|benchmarks|worktrees|all] [--keep-contexts N] [--dry-run]
  metis reset [--dry-run] --yes
  metis uninstall [--host codex|claude|opencode|all] [--dry-run] [--force-modified] [--discard-modified] [--purge-state --yes]
  metis benchmark init --baseline-commit <SHA> [--candidate-commit <SHA>]
  metis benchmark run --yes --file <file> [--baseline-commit <SHA>] [--candidate-commit <SHA>] [--allow-repository-exec]
  metis benchmark report|compare ...

Controller flags for state-changing commands:
  --controller-session <id>
  --controller-owner <name>
  --controller-token <secret>
  --controller-fence <number>

Global flags:
  --root <path>  Project root. Defaults to the current Git repository.
  --run <id>     Select a run. Defaults to the active run.
  --pretty       Pretty-print JSON.
  --quiet        Print only the primary string result.
  --help         Show help.
`;

function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const equal = token.indexOf("=");
    if (equal > 2) {
      flags[token.slice(2, equal)] = token.slice(equal + 1);
      continue;
    }
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[name] = next;
      index += 1;
    } else {
      flags[name] = true;
    }
  }
  return { positionals, flags };
}

function toBoolean(value, fallback = false) {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  return !["0", "false", "no", "off"].includes(String(value).toLowerCase());
}

function integer(value, fallback = null) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  invariant(Number.isInteger(parsed) && parsed >= 0, "INTEGER_REQUIRED", `Expected a non-negative integer, got ${value}.`);
  return parsed;
}

function commaList(value) {
  if (value === undefined || value === null || value === false) return [];
  return [...new Set(String(value).split(",").map((item) => item.trim()).filter(Boolean))];
}

function jsonFlag(value, fallback = []) {
  if (value === undefined || value === null || value === false) return fallback;
  try {
    return JSON.parse(String(value));
  } catch (error) {
    throw new MetisError("INVALID_JSON_FLAG", `Flag value is not valid JSON: ${error.message}`);
  }
}

function containedInputPath(root, file) {
  const rootPath = realpathSync(root);
  // Resolve relative to the child's current workspace, then enforce that the
  // resulting real path remains inside the active repository root. This lets
  // isolated task worktrees use the same task-scoped relative result path.
  const requested = path.resolve(String(file));
  const candidateParent = path.dirname(requested);
  let parent;
  try {
    parent = realpathSync(candidateParent);
  } catch (error) {
    throw new MetisError("INPUT_FILE_INVALID", `Input file parent is not readable: ${error.message}`);
  }
  invariant(parent.startsWith(`${rootPath}${path.sep}`), "INPUT_FILE_SCOPE", "Input file parent must remain inside the active repository root.");
  return { rootPath, candidate: path.join(parent, path.basename(requested)) };
}

export function containedInputFile(root, file, maxBytes = 1_000_000) {
  const { rootPath, candidate } = containedInputPath(root, file);
  let descriptor;
  try {
    descriptor = openSync(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    invariant(stat.isFile(), "INPUT_FILE_INVALID", "Input file must be a regular file.");
    invariant(stat.size <= maxBytes, "INPUT_FILE_TOO_LARGE", `Input file exceeds the ${maxBytes}-byte limit.`);
    // The parent identity was checked before opening and O_NOFOLLOW prevents
    // the final path component from being swapped to a symlink. Read the same
    // descriptor that was checked, eliminating path-based TOCTOU on content.
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) offset += readSync(descriptor, buffer, offset, buffer.length - offset, null);
    return buffer.toString("utf8");
  } catch (error) {
    if (error instanceof MetisError) throw error;
    throw new MetisError("INPUT_FILE_INVALID", `Input file is not readable: ${error.message}`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

async function inputValue(flags, fallback = null, options = {}) {
  if (flags.file) return options.containedRoot
    ? containedInputFile(options.containedRoot, flags.file, options.maxBytes)
    : readFileSync(path.resolve(String(flags.file)), "utf8");
  if (flags.data !== undefined) return String(flags.data);
  const stdin = await readStdin();
  return stdin.trim() ? stdin : fallback;
}

async function inputJson(flags, fallback = null, options = {}) {
  const text = await inputValue(flags, fallback === null ? null : JSON.stringify(fallback), options);
  invariant(text !== null, "INPUT_REQUIRED", "Provide JSON through --data, --file, or stdin.");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new MetisError("INVALID_JSON", `Input is not valid JSON: ${error.message}`);
  }
}

function primaryResult(value) {
  if (typeof value === "string") return value;
  if (value?.content && typeof value.content === "string") return value.content;
  if (value?.id) return value.id;
  return stableStringify(value);
}

function emit(value, flags, io = process) {
  if (flags.quiet) {
    io.stdout.write(`${primaryResult(value)}\n`);
    return;
  }
  if (typeof value === "string") {
    io.stdout.write(value.endsWith("\n") ? value : `${value}\n`);
    return;
  }
  const text = flags.pretty ? JSON.stringify(value, null, 2) : stableStringify(value);
  io.stdout.write(`${text}\n`);
}

function commandKey(positionals, length = 2) {
  return positionals.slice(0, length).join(" ");
}

function resolveRun(db, flags) {
  return getRun(db, flags.run ? String(flags.run) : null);
}

function contextOptions(flags, config) {
  return {
    tokenBudget: integer(flags.tokens, config.budgets.mainContextTokens),
    remainingTokens: integer(flags["remaining-tokens"], null),
    observedTokens: integer(flags["observed-tokens"], null),
    model: flags.model ?? config.budgets.model ?? null
  };
}

const CONTROLLER_MUTATIONS = new Set([
  "drive", "advance", "reopen", "block", "pause", "resume",
  "controller materialize",
  "contract freeze", "contract amend",
  "requirement status", "requirement link",
  "assumption add", "assumption status", "invariant add", "invariant status", "risk add", "risk status",
  "artifact put", "artifact waive", "milestone add", "interface add", "interface freeze",
  "task add", "task claim", "task retry", "task waive", "task packet compile",
  "design seal", "design review", "plan seal", "plan review", "plan ingest",
  "schedule claim", "schedule ack", "schedule heartbeat", "schedule abort", "schedule child-failure",
  "review ingest", "review status", "review reconcile", "verification candidate",
  "finding add", "finding status", "decision add", "decision status",
  "check detect", "check add", "check run",
  "browser add", "browser run", "checkpoint add", "checkpoint resolve",
  "docs add", "docs resolve", "repo sync", "knowledge sync",
  "budget consume", "progress sample", "evaluate"
]);

function controllerInput(flags) {
  const sessionId = flags["controller-session"] ?? process.env.METIS_CONTROLLER_SESSION;
  const owner = flags["controller-owner"] ?? process.env.METIS_CONTROLLER_OWNER;
  const token = flags["controller-token"] ?? process.env.METIS_CONTROLLER_TOKEN;
  const fencingToken = flags["controller-fence"] ?? process.env.METIS_CONTROLLER_FENCE;
  if (!sessionId && !owner && !token && fencingToken === undefined) return null;
  return { sessionId: String(sessionId ?? ""), owner: String(owner ?? ""), token: String(token ?? ""), fencingToken: Number(fencingToken) };
}

function mutationKey(positionals) {
  const top = positionals[0] ?? "";
  if (top === "task" && positionals[1] === "packet") return commandKey(positionals, 3);
  if (top === "evaluate" && positionals[1] === "latest") return commandKey(positionals);
  if (["next", "context", "gate", "advance", "reopen", "block", "pause", "resume", "evaluate"].includes(top)) return top;
  return commandKey(positionals);
}

function guardController(db, flags, config, positionals) {
  const key = mutationKey(positionals);
  if (!CONTROLLER_MUTATIONS.has(key)) return null;
  const run = resolveRun(db, flags);
  return assertController(db, run.id, controllerInput(flags), { heartbeat: true, leaseSeconds: config.controller.leaseSeconds });
}

function statusView(db, projectRoot, run, config, includeContext) {
  const tasks = listTasks(db, run.id);
  const checks = listChecks(db, run.id);
  const documents = listDocumentImpacts(db, run.id);
  const findings = listFindings(db, run.id);
  const runnable = getRunnableTasks(db, run.id, config.orchestration.maxConcurrent);
  const milestones = listMilestones(db, run.id);
  const value = {
    run,
    summary: {
      milestones: Object.fromEntries([...new Set(milestones.map((item) => item.status))].sort().map((status) => [status, milestones.filter((item) => item.status === status).length])),
      tasks: Object.fromEntries([...new Set(tasks.map((item) => item.status))].sort().map((status) => [status, tasks.filter((item) => item.status === status).length])),
      checks: Object.fromEntries(checks.map((item) => [item.name, item.status])),
      pendingDocuments: documents.filter((item) => item.status === "pending").length,
      staleFindings: findings.filter((item) => item.status === "stale").length,
      runnableTasks: runnable.map((item) => ({ id: item.id, title: item.title, role: item.role, taskKind: item.taskKind, wave: item.wave, contractStatus: item.contractStatus, milestoneId: item.milestone_id }))
    }
  };
  if (includeContext) value.context = buildMainContext(db, projectRoot, run.id, config);
  return value;
}

async function dispatch(positionals, flags, context) {
  const { projectRoot, config, db } = context;
  const top = positionals[0];
  const key = top === "task" && positionals[1] === "packet" ? commandKey(positionals, 3) : commandKey(positionals);

  if (!top || top === "help" || flags.help) return HELP;

  if (top === "init") {
    const hosts = String(flags.host ?? "codex").split(",").map((item) => item.trim()).filter(Boolean);
    const installed = installAdapters(projectRoot, hosts, toBoolean(flags.force));
    const savedConfig = ensureConfig(projectRoot, { host: hosts[0] === "all" ? "codex" : hosts[0] });
    return { projectRoot, installed, config: savedConfig };
  }

  if (top === "attach") {
    return attachProject({
      root: projectRoot,
      host: String(flags.host ?? "codex").split(",").map((item) => item.trim()).filter(Boolean),
      force: false
    });
  }

  if (key === "model show") return modelConfigView(config, flags.host ?? null);
  if (key === "model configure") {
    invariant(!activeRun(db), "MODEL_CONFIG_ACTIVE_RUN", "Model configuration is frozen while a run is active or blocked. Complete the run, then configure the next goal.");
    return configureModels(projectRoot, config, await inputJson(flags));
  }
  if (key === "model reset") {
    invariant(toBoolean(flags.yes), "CONFIRM_REQUIRED", "Resetting project model routes requires --yes.");
    invariant(!activeRun(db), "MODEL_CONFIG_ACTIVE_RUN", "Model configuration is frozen while a run is active or blocked. Complete the run, then reset it.");
    return resetModels(projectRoot, config);
  }

  if (top === "start") {
    const goal = positionals.slice(1).join(" ").trim() || String(await inputValue(flags, "") ?? "").trim();
    const supplied = controllerInput(flags);
    const result = startRun(db, projectRoot, config, goal, {
      host: flags.host,
      approvalPolicy: flags.approval,
      controller: supplied,
      controllerSessionId: flags["controller-session"] ?? process.env.METIS_CONTROLLER_SESSION,
      controllerOwner: flags["controller-owner"] ?? process.env.METIS_CONTROLLER_OWNER,
      takeover: toBoolean(flags.takeover)
    });
    return { ...result, context: buildMainContext(db, projectRoot, result.run.id, config, contextOptions(flags, config)) };
  }

  if (key === "controller status") return controllerStatus(db, resolveRun(db, flags).id);
  if (key === "controller heartbeat") {
    const run = resolveRun(db, flags);
    return heartbeatController(db, run.id, controllerInput(flags), config.controller.leaseSeconds);
  }
  if (key === "controller takeover") {
    const force = toBoolean(flags.force);
    invariant(!force || toBoolean(flags.yes), "CONFIRM_REQUIRED", "Forced controller takeover requires --yes.");
    const run = resolveRun(db, flags);
    return takeoverController(db, run.id, {
      sessionId: flags["controller-session"] ?? process.env.METIS_CONTROLLER_SESSION,
      owner: flags["controller-owner"] ?? process.env.METIS_CONTROLLER_OWNER,
      leaseSeconds: config.controller.leaseSeconds,
      force
    });
  }

  context.controller = guardController(db, flags, config, positionals);

  if (key === "controller materialize") {
    const run = resolveRun(db, flags);
    return materializeControllerTaskWave(db, projectRoot, run.id, await inputJson(flags), context.controller, config);
  }

  if (top === "status") {
    const run = resolveRun(db, flags);
    if (flags.markdown) return reportMarkdown(buildReport(db, run.id));
    if (toBoolean(flags.context)) assertController(db, run.id, controllerInput(flags), { heartbeat: true, leaseSeconds: config.controller.leaseSeconds });
    return statusView(db, projectRoot, run, config, toBoolean(flags.context));
  }

  if (top === "next") {
    const run = resolveRun(db, flags);
    const action = nextControllerAction(db, projectRoot, run.id, config);
    const mainContext = buildMainContext(db, projectRoot, run.id, config, { ...contextOptions(flags, config), action });
    return { action, context: mainContext };
  }

  if (top === "drive") {
    const run = resolveRun(db, flags);
    return driveController(db, projectRoot, run.id, context.controller, config, {
      maxIterations: integer(flags["max-iterations"], undefined)
    });
  }

  if (top === "context") {
    const run = resolveRun(db, flags);
    return buildMainContext(db, projectRoot, run.id, config, contextOptions(flags, config));
  }

  if (top === "gate") {
    const run = resolveRun(db, flags);
    return gateReport(db, projectRoot, run.id, positionals[1] ?? null);
  }

  if (top === "advance") {
    const run = resolveRun(db, flags);
    return advancePhase(db, projectRoot, run.id, positionals[1] ?? null);
  }

  if (top === "reopen") {
    const run = resolveRun(db, flags);
    return reopenPhase(db, run.id, positionals[1], positionals.slice(2).join(" "));
  }

  if (top === "block") {
    const run = resolveRun(db, flags);
    return blockRun(db, run.id, positionals.slice(1).join(" "));
  }

  if (top === "pause") {
    const run = resolveRun(db, flags);
    return pauseRun(db, run.id, positionals.slice(1).join(" "));
  }

  if (top === "resume") return resumeRun(db, resolveRun(db, flags).id);

  if (key === "contract freeze") return freezeGoalContract(db, projectRoot, resolveRun(db, flags).id, await inputJson(flags));
  if (key === "contract get") return getGoalContract(db, resolveRun(db, flags).id) ?? { found: false };
  if (key === "contract amend") return amendGoalContract(db, projectRoot, resolveRun(db, flags).id, await inputJson(flags));

  if (key === "requirement list") return listRequirements(db, resolveRun(db, flags).id, flags.status ?? null);
  if (key === "requirement status") {
    const run = resolveRun(db, flags);
    return setRequirementStatus(
      db,
      run.id,
      positionals[2],
      positionals[3],
      jsonFlag(flags.evidence, []),
      projectRoot
    );
  }
  if (key === "requirement link") return linkRequirement(db, projectRoot, resolveRun(db, flags).id, await inputJson(flags));
  if (key === "trace list") return listTraceLinks(db, resolveRun(db, flags).id, flags.requirement ?? null);
  if (key === "trace report") return traceabilityReport(db, resolveRun(db, flags).id, { refreshStatuses: toBoolean(flags.refresh, true) });

  if (key === "assumption add") return addAssumption(db, projectRoot, resolveRun(db, flags).id, await inputJson(flags));
  if (key === "assumption get") return getAssumption(db, positionals[2]);
  if (key === "assumption list") return listAssumptions(db, resolveRun(db, flags).id, flags.status ?? null);
  if (key === "assumption status") {
    return setAssumptionStatus(db, projectRoot, resolveRun(db, flags).id, positionals[2], positionals[3], await inputJson(flags, {}));
  }

  if (key === "invariant add") return addInvariant(db, projectRoot, resolveRun(db, flags).id, await inputJson(flags));
  if (key === "invariant get") return getInvariant(db, positionals[2]);
  if (key === "invariant list") return listInvariants(db, resolveRun(db, flags).id, flags.status ?? null);
  if (key === "invariant status") {
    return setInvariantStatus(db, projectRoot, resolveRun(db, flags).id, positionals[2], positionals[3], await inputJson(flags, {}));
  }

  if (key === "risk add") return addRisk(db, projectRoot, resolveRun(db, flags).id, await inputJson(flags));
  if (key === "risk get") return getRisk(db, positionals[2]);
  if (key === "risk list") return listRisks(db, resolveRun(db, flags).id, flags.status ?? null);
  if (key === "risk status") {
    return setRiskStatus(db, projectRoot, resolveRun(db, flags).id, positionals[2], positionals[3], await inputJson(flags, {}));
  }
  if (key === "governance report") return governanceReport(db, resolveRun(db, flags).id, config);

  if (key === "artifact put") {
    const run = resolveRun(db, flags);
    const kind = positionals[2];
    invariant(kind, "ARTIFACT_KIND_REQUIRED", "Specify an artifact kind.");
    invariant(!isProtectedLifecycleArtifactKind(kind), "ARTIFACT_PROTECTED_KIND", `Artifact ${kind} is produced only by its authenticated lifecycle command.`);
    const raw = await inputValue(flags);
    invariant(raw !== null, "ARTIFACT_CONTENT_REQUIRED", "Provide artifact content through --data, --file, or stdin.");
    let content = raw;
    try { content = JSON.parse(raw); } catch {}
    return putArtifact(db, projectRoot, run.id, kind, content, { status: flags.status ?? "verified", path: flags.path ?? null });
  }

  if (key === "artifact get") return getArtifact(db, projectRoot, positionals[2]);
  if (key === "artifact latest") {
    const run = resolveRun(db, flags);
    return latestArtifact(db, projectRoot, run.id, positionals[2]) ?? { found: false };
  }
  if (key === "artifact waive") {
    const run = resolveRun(db, flags);
    const kind = positionals[2];
    invariant(!isProtectedLifecycleArtifactKind(kind), "ARTIFACT_PROTECTED_KIND", `Artifact ${kind} cannot be waived.`);
    return waiveArtifact(db, projectRoot, run.id, kind, positionals.slice(3).join(" "));
  }

  if (key === "object get") {
    const ref = positionals[2];
    invariant(ref, "OBJECT_REF_REQUIRED", "Specify an obj_ reference.");
    const content = readObject(db, projectRoot, ref);
    invariant(content !== null, "OBJECT_NOT_FOUND", `Object ${ref} was not found.`);
    if (flags.out) {
      const output = path.resolve(String(flags.out));
      writeFileSync(output, content, Buffer.isBuffer(content) ? undefined : "utf8");
      return { ref, output };
    }
    if (Buffer.isBuffer(content)) return { ref, encoding: "base64", content: content.toString("base64") };
    return content;
  }

  if (key === "milestone add") return addMilestone(db, resolveRun(db, flags).id, await inputJson(flags));
  if (key === "milestone list") return listMilestones(db, resolveRun(db, flags).id);
  if (key === "milestone get") return getMilestone(db, positionals[2]);

  if (key === "interface add") return addInterfaceContract(db, resolveRun(db, flags).id, await inputJson(flags));
  if (key === "interface list") return listInterfaceContracts(db, resolveRun(db, flags).id, { status: flags.status });
  if (key === "interface get") return getInterfaceContract(db, positionals[2], resolveRun(db, flags).id);
  if (key === "interface freeze") return freezeInterfaceContract(db, resolveRun(db, flags).id, positionals[2]);

  if (key === "task packet compile") {
    const overlay = flags.file || flags.data ? await inputJson(flags) : undefined;
    return compileTaskPacket(db, projectRoot, positionals[3], config, overlay === undefined ? {} : { overlay });
  }
  if (key === "task packet get") return getTaskPacket(db, positionals[3], config);
  if (key === "task packet status") return taskPacketStatus(db, positionals[3], config);
  if (key === "task packet list") return listTaskPackets(db, resolveRun(db, flags).id, config);

  if (key === "task add") return addTask(db, resolveRun(db, flags).id, await inputJson(flags), config);
  if (key === "task get") return getTask(db, positionals[2]);
  if (key === "task list") return listTasks(db, resolveRun(db, flags).id, flags.status ?? null);
  if (key === "task runnable") return getRunnableTasks(db, resolveRun(db, flags).id, integer(flags.limit, config.orchestration.maxConcurrent));

  if (key === "task contract") {
    const contract = taskContract(db, positionals[2]);
    return compactTaskContract(contract, integer(flags.tokens, config.budgets.taskPacketTokens), {
      db,
      config,
      model: flags.model ?? contract.Model
    });
  }

  if (key === "task claim") {
    const run = resolveRun(db, flags);
    invariant(flags.owner, "OWNER_REQUIRED", "Task claim requires --owner.");
    const claimed = claimTask(db, run.id, positionals[2], String(flags.owner), config);
    const compact = compactTaskContract(claimed.contract, config.budgets.taskPacketTokens, {
      db,
      config,
      model: claimed.task.selected_model
    });
    return {
      ...claimed,
      contract: compact,
      spawn: renderSpawnDescriptor(run.host, claimed.task, compact, {
        leaseToken: claimed.leaseToken,
        parentRoot: claimed.contract.IntegrationRoot ?? run.project_root
      })
    };
  }

  if (key === "task heartbeat") {
    const run = resolveRun(db, flags);
    invariant(flags.lease, "LEASE_REQUIRED", "Task heartbeat requires --lease.");
    return heartbeatTask(db, run.id, positionals[2], String(flags.lease), config, flags.minutes === undefined ? null : integer(flags.minutes));
  }

  if (key === "task finish") {
    const run = resolveRun(db, flags);
    invariant(flags.lease, "LEASE_REQUIRED", "Task finish requires --lease.");
    const resultFile = flags.file ? containedInputPath(projectRoot, flags.file).candidate : null;
    const result = finishTask(db, projectRoot, run.id, positionals[2], String(flags.lease), await inputJson(flags, null, {
      containedRoot: projectRoot,
      maxBytes: 1_000_000
    }), config);
    if (resultFile) {
      try { unlinkSync(resultFile); } catch {}
    }
    return result;
  }

  if (key === "task retry") {
    const run = resolveRun(db, flags);
    return retryTask(db, run.id, positionals[2], positionals.slice(3).join(" "), config, String(flags.cause ?? "transient"));
  }

  if (key === "task waive") return waiveTask(db, resolveRun(db, flags).id, positionals[2], positionals.slice(3).join(" "));

  if (key === "design lint") return lintDesign(db, projectRoot, resolveRun(db, flags).id, config);
  if (key === "design seal") return sealDesign(db, projectRoot, resolveRun(db, flags).id, config);
  if (key === "design review") return recordDesignReview(db, projectRoot, resolveRun(db, flags).id, await inputJson(flags, {}), config);

  if (key === "plan seal") {
    const run = resolveRun(db, flags);
    const sealed = sealPlan(db, run.id, config);
    const draftBinding = currentPlanDraftBinding(db, projectRoot, run.id);
    const artifact = putArtifact(db, projectRoot, run.id, "plan", sealed.content, {
      status: "verified",
      metadata: {
        planHash: sealed.planHash,
        version: sealed.content.version,
        ...(draftBinding ? {
          planDraftArtifactId: draftBinding.draftArtifactId,
          planDraftIngestedArtifactId: draftBinding.receiptArtifactId,
          planDraftContentRef: draftBinding.draftContentRef,
          plannedGraphFingerprint: draftBinding.plannedGraphFingerprint,
          plannerTaskId: draftBinding.plannerTaskId
        } : {})
      }
    });
    return { graph: sealed.graph, milestoneGraph: sealed.milestoneGraph, milestones: sealed.milestones, tasks: sealed.tasks, planHash: sealed.planHash, artifactId: artifact.id };
  }

  if (key === "plan ingest") {
    const run = resolveRun(db, flags);
    return ingestPlanDraft(db, projectRoot, run.id, positionals[2], config);
  }
  if (key === "plan lint") return lintPlan(db, resolveRun(db, flags).id, config, projectRoot);
  if (key === "plan review") {
    const run = resolveRun(db, flags);
    return recordPlanReview(db, projectRoot, run.id, await inputJson(flags, {}), config);
  }

  if (key === "schedule propose") {
    return proposeSchedule(db, projectRoot, resolveRun(db, flags).id, config, {
      limit: integer(flags.limit, null),
      parentTaskId: flags["parent-task"] ?? null
    });
  }
  if (key === "schedule claim") {
    return claimSchedule(db, projectRoot, resolveRun(db, flags).id, config, {
      owner: flags.owner ?? context.controller?.owner ?? "metis-main",
      limit: integer(flags.limit, null),
      parentTaskId: flags["parent-task"] ?? null,
      controllerFencingToken: context.controller?.fencingToken
    });
  }
  if (key === "schedule ack") {
    const run = resolveRun(db, flags);
    return acknowledgeScheduleSpawn(
      db,
      run.id,
      positionals[2],
      commaList(flags.tasks),
      flags.owner ?? context.controller?.owner ?? "metis-main",
      config,
      jsonFlag(flags.receipts, null)
    );
  }
  if (key === "schedule heartbeat") {
    const run = resolveRun(db, flags);
    return heartbeatScheduleBatch(db, run.id, positionals[2], config);
  }
  if (key === "schedule abort") {
    const run = resolveRun(db, flags);
    return abortScheduleBatch(
      db,
      projectRoot,
      run.id,
      positionals[2],
      flags.reason ?? positionals.slice(3).join(" "),
      {
        expectedStatus: flags["expected-status"],
        expectedUpdatedAt: flags["expected-updated-at"],
        expectedControllerFencingToken: integer(flags["expected-controller-fence"], undefined)
      }
    );
  }
  if (key === "schedule child-failure") {
    const run = resolveRun(db, flags);
    return handleChildTerminal(
      db,
      projectRoot,
      run.id,
      positionals[2],
      String(flags.task ?? positionals[3] ?? ""),
      await inputJson(flags, {}),
      config
    );
  }
  if (key === "schedule status") return refreshScheduleBatch(db, positionals[2]);

  if (key === "capability list") return listCapabilities(db);
  if (key === "capability explain") return capabilityExplanation(db, positionals[2]);

  if (key === "checkpoint add") return addCheckpoint(db, resolveRun(db, flags).id, await inputJson(flags));
  if (key === "checkpoint list") return listCheckpoints(db, resolveRun(db, flags).id, { status: flags.status, kind: flags.kind });
  if (key === "checkpoint get") return getCheckpoint(db, positionals[2]);
  if (key === "checkpoint resolve") return resolveCheckpoint(db, resolveRun(db, flags).id, positionals[2], {
    status: flags.status ?? "resolved",
    resolution: flags.resolution ?? positionals.slice(3).join(" "),
    resolvedBy: flags.by ?? "user"
  });
  if (key === "checkpoint status" || key === "uat status") return checkpointStatus(db, resolveRun(db, flags).id);

  if (key === "browser add") return registerBrowserScenario(db, resolveRun(db, flags).id, await inputJson(flags));
  if (key === "browser get") return getBrowserScenario(db, resolveRun(db, flags).id, positionals[2]);
  if (key === "browser list") return listBrowserScenarios(db, resolveRun(db, flags).id);
  if (key === "browser run") return runBrowserScenario(db, projectRoot, resolveRun(db, flags).id, positionals[2], config, { timeoutMs: integer(flags["timeout-ms"], null) });
  if (key === "browser status") {
    const run = resolveRun(db, flags);
    return browserStatus(db, run.id, repositoryCodeFingerprint(db));
  }

  if (key === "review ingest") return ingestReviewTask(db, projectRoot, resolveRun(db, flags).id, positionals[2]);
  if (key === "review list") return listReviewFindings(db, resolveRun(db, flags).id, { status: flags.status, reviewKind: flags.kind });
  if (key === "review get") return getReviewFinding(db, positionals[2]);
  if (key === "review status") return setReviewFindingStatus(db, resolveRun(db, flags).id, positionals[2], positionals[3], {
    disposition: flags.disposition ?? flags.note ?? null
  });
  if (key === "review reconcile") return reconcileReview(db, projectRoot, resolveRun(db, flags).id, config, { reviewKind: flags.kind ?? "integration" });
  if (key === "review report") return reviewReport(db, resolveRun(db, flags).id);
  if (key === "verification candidate") return createVerificationCandidate(db, projectRoot, resolveRun(db, flags).id, config);
  if (key === "verification get") return getVerificationCandidate(db, projectRoot, resolveRun(db, flags).id);

  if (key === "finding add") return addFinding(db, projectRoot, resolveRun(db, flags).id, await inputJson(flags));
  if (key === "finding list") return listFindings(db, resolveRun(db, flags).id, { status: flags.status, kind: flags.kind });
  if (key === "finding get") return getFinding(db, positionals[2]);
  if (key === "finding status") return setFindingStatus(db, projectRoot, resolveRun(db, flags).id, positionals[2], positionals[3], flags.note ?? null);

  if (key === "decision add") return addDecision(db, resolveRun(db, flags).id, await inputJson(flags));
  if (key === "decision list") return listDecisions(db, resolveRun(db, flags).id, flags.status === "all" ? null : flags.status ?? "active");
  if (key === "decision get") return getDecision(db, positionals[2]);
  if (key === "decision status") return setDecisionStatus(db, resolveRun(db, flags).id, positionals[2], positionals[3], flags.note ?? null);

  if (key === "check detect") return registerDetectedChecks(db, projectRoot, resolveRun(db, flags).id);
  if (key === "check add") {
    invariant(flags.name && (flags.command || flags["command-json"]), "CHECK_FIELDS", "check add requires --name and a structured command.");
    const command = flags["command-json"]
      ? jsonFlag(flags["command-json"], null)
      : { command: String(flags.command), args: jsonFlag(flags.args, []), cwd: flags.cwd ?? null, timeoutMs: integer(flags["timeout-ms"], null) };
    return registerCheck(db, resolveRun(db, flags).id, {
      name: flags.name,
      command,
      required: !toBoolean(flags.optional),
      requirementIds: commaList(flags.requirements),
      invariantIds: commaList(flags.invariants)
    });
  }
  if (key === "check list") return listChecks(db, resolveRun(db, flags).id);
  if (key === "check run") return runChecks(db, projectRoot, resolveRun(db, flags).id, config, { name: flags.name, continueOnFailure: toBoolean(flags.continue) });

  if (key === "docs add") return addDocumentImpact(
    db,
    resolveRun(db, flags).id,
    String(flags.path ?? ""),
    String(flags.reason ?? ""),
    jsonFlag(flags.evidence, []),
    commaList(flags.requirements)
  );
  if (key === "docs list") return listDocumentImpacts(db, resolveRun(db, flags).id, flags.status ?? null);
  if (key === "docs resolve") return resolveDocumentImpact(
    db,
    resolveRun(db, flags).id,
    flags.id ? { id: flags.id } : { path: flags.path },
    flags.disposition ?? "updated",
    jsonFlag(flags.evidence, [])
  );

  if (key === "repo sync") {
    const run = activeRun(db);
    return syncRepository(db, projectRoot, config, flags.run ?? run?.id ?? null);
  }
  if (key === "knowledge sync") return synchronizeKnowledge(db, projectRoot, resolveRun(db, flags).id, config);
  if (key === "knowledge search") return searchProjectKnowledge(db, positionals.slice(2).join(" "), integer(flags.limit, 12));

  if (key === "budget status") return budgetStatus(db, resolveRun(db, flags).id);
  if (key === "budget consume") return consumeBudget(db, resolveRun(db, flags).id, await inputJson(flags), {
    source: flags.source ?? "cli",
    failClosed: toBoolean(flags["fail-closed"])
  });
  if (key === "progress sample") return sampleProgress(db, resolveRun(db, flags).id, config, { ignoreStall: toBoolean(flags["ignore-stall"]) });
  if (key === "progress status") return progressStatus(db, resolveRun(db, flags).id) ?? { found: false };
  if (key === "journal list") return listJournal(db, resolveRun(db, flags).id, { after: integer(flags.after, 0), limit: integer(flags.limit, 500) });
  if (key === "journal replay") return replayJournal(db, resolveRun(db, flags).id, { limit: integer(flags.limit, 10000) });
  if (top === "evaluate" && positionals[1] === "latest") return latestEvaluation(db, resolveRun(db, flags).id) ?? { found: false };
  if (top === "evaluate") return evaluateRun(db, projectRoot, resolveRun(db, flags).id, config);

  if (key === "usage add") {
    const run = flags.run ? resolveRun(db, flags) : activeRun(db);
    return recordUsageSample(db, run?.id ?? null, await inputJson(flags));
  }
  if (key === "usage calibration") return usageCalibration(db, flags.model ?? null);

  if (top === "metrics") {
    const run = activeRun(db) ?? db.prepare("SELECT * FROM runs ORDER BY updated_at DESC LIMIT 1").get();
    return tokenMetrics(db, flags.run ?? run?.id ?? null);
  }

  if (top === "storage") {
    return {
      runtime: storageInventory(projectRoot),
      ...(toBoolean(flags.installation) ? { installation: installationInventory(projectRoot) } : {})
    };
  }

  if (key === "install status") return installationInventory(projectRoot);

  if (top === "gc") {
    return garbageCollect(db, projectRoot, {
      keepContexts: integer(flags["keep-contexts"], config.cleanup.keepContexts),
      dryRun: toBoolean(flags["dry-run"])
    });
  }

  if (top === "clean") {
    return cleanRuntime(db, projectRoot, {
      keepContexts: integer(flags["keep-contexts"], config.cleanup.keepContexts),
      scopes: flags.scope ? String(flags.scope).split(",") : ["cache"],
      dryRun: toBoolean(flags["dry-run"]),
      forceEphemeral: toBoolean(flags["force-ephemeral"]),
      worktreeMaxAgeMinutes: Math.max(0, Number(config.cleanup.worktreeMaxAgeHours ?? 24) * 60)
    });
  }

  if (key === "benchmark init") {
    const head = runCommand("git", ["rev-parse", "HEAD"], { cwd: projectRoot, timeout: 5000 });
    return initializeBenchmark(projectRoot, {
      name: flags.name,
      file: flags.file,
      force: toBoolean(flags.force),
      baselineCommit: flags["baseline-commit"],
      candidateCommit: flags["candidate-commit"] ?? (head.status === 0 ? head.stdout.trim() : null)
    });
  }
  if (key === "benchmark run") {
    invariant(toBoolean(flags.yes), "BENCHMARK_CONFIRM", "Live benchmarks invoke external agents. Re-run with --yes.");
    return runBenchmark(db, projectRoot, {
      file: flags.file,
      baselineCommit: flags["baseline-commit"],
      candidateCommit: flags["candidate-commit"],
      scenario: flags.scenario,
      variant: flags.variant,
      repetitions: integer(flags.repetitions, null),
      timeoutMs: integer(flags["timeout-ms"], null),
      keepWorkspaces: toBoolean(flags["keep-workspaces"]),
      allowRepositoryExec: toBoolean(flags["allow-repository-exec"])
    });
  }
  if (key === "benchmark report") return benchmarkReport(db, flags.name ?? null);
  if (key === "benchmark compare") return compareBenchmarkVariants(db, positionals[2], positionals[3], positionals[4], {
    projectRoot,
    file: flags.file,
    baselineCommit: flags["baseline-commit"],
    candidateCommit: flags["candidate-commit"]
  });

  if (top === "doctor") return doctor(projectRoot, config, db);
  if (top === "report") {
    const run = resolveRun(db, flags);
    const report = buildReport(db, run.id);
    const output = flags.markdown ? reportMarkdown(report) : report;
    if (flags.out) writeFileSync(path.resolve(String(flags.out)), typeof output === "string" ? output : `${JSON.stringify(output, null, 2)}\n`, "utf8");
    return output;
  }

  if (key === "performance report") {
    const run = resolveRun(db, flags);
    return performanceReport(db, run.id);
  }

  throw new MetisError("UNKNOWN_COMMAND", `Unknown command: ${positionals.join(" ")}`);
}

function normalizeError(error) {
  return error instanceof MetisError
    ? error
    : new MetisError("INTERNAL_ERROR", error?.message ?? String(error), { stack: error?.stack });
}

export async function main(argv = process.argv.slice(2), io = process) {
  assertSupportedNodeVersion();
  const { positionals, flags } = parseArgs(argv);
  if (flags.help || positionals[0] === "help" || positionals.length === 0) {
    emit(HELP, flags, io);
    return 0;
  }
  if (positionals[0] === "init") {
    try {
      const host = String(flags.host ?? "codex").split(",").map((item) => item.trim()).filter(Boolean);
      const result = attachProject({ root: flags.root, cwd: process.cwd(), host, force: toBoolean(flags.force) });
      emit(result, flags, io);
      return 0;
    } catch (error) {
      const normalized = normalizeError(error);
      const payload = { error: { code: normalized.code, message: normalized.message, details: normalized.details } };
      io.stderr.write(`${flags.pretty ? JSON.stringify(payload, null, 2) : stableStringify(payload)}\n`);
      return normalized.code === "INTERNAL_ERROR" ? 2 : 1;
    }
  }

  if (positionals[0] === "lifecycle") {
    try {
      const resolved = resolveProjectRoot({ root: flags.root, cwd: process.cwd() });
      emit(routeLifecycle({ projectRoot: resolved.projectRoot }), flags, io);
      return 0;
    } catch (error) {
      const normalized = normalizeError(error);
      const payload = { error: { code: normalized.code, message: normalized.message, details: normalized.details } };
      io.stderr.write(`${flags.pretty ? JSON.stringify(payload, null, 2) : stableStringify(payload)}\n`);
      return normalized.code === "INTERNAL_ERROR" ? 2 : 1;
    }
  }

  let projectRoot;
  try {
    projectRoot = resolveProjectRoot({ root: flags.root }).projectRoot;
  } catch (error) {
    const normalized = normalizeError(error);
    emit({ error: { code: normalized.code, message: normalized.message, details: normalized.details } }, flags, io);
    return normalized.code === "INTERNAL_ERROR" ? 2 : 1;
  }

  if (positionals[0] === "reset") {
    const dryRun = toBoolean(flags["dry-run"]);
    if (!dryRun && !toBoolean(flags.yes)) {
      emit({ error: { code: "CONFIRM_REQUIRED", message: "reset removes all Metis run state. Re-run with --yes." } }, flags, io);
      return 1;
    }
    emit(resetRuntime(projectRoot, { dryRun }), flags, io);
    return 0;
  }

  if (positionals[0] === "uninstall") {
    try {
      const hosts = String(flags.host ?? "all").split(",").map((item) => item.trim()).filter(Boolean);
      const dryRun = toBoolean(flags["dry-run"]);
      const purgeState = toBoolean(flags["purge-state"]);
      if (purgeState && !dryRun && !toBoolean(flags.yes)) {
        emit({ error: { code: "CONFIRM_REQUIRED", message: "--purge-state removes all Metis run state. Re-run with --yes." } }, flags, io);
        return 1;
      }
      const forceModified = toBoolean(flags["force-modified"]);
      const discardModified = toBoolean(flags["discard-modified"]);
      if (discardModified && !forceModified) {
        emit({ error: { code: "FORCE_REQUIRED", message: "--discard-modified requires --force-modified." } }, flags, io);
        return 1;
      }
      if (purgeState && forceModified && !discardModified) {
        emit({
          error: {
            code: "MODIFIED_BACKUP_WOULD_BE_PURGED",
            message: "State purge would remove modified-file backups. Review them first, or add --discard-modified to accept data loss."
          }
        }, flags, io);
        return 1;
      }
      const result = uninstallAdapters(projectRoot, hosts, {
        dryRun,
        forceModified,
        backupModified: forceModified && !discardModified
      });
      if (purgeState && result.conflicts.length === 0) result.state = resetRuntime(projectRoot, { dryRun });
      emit(result, flags, io);
      return result.conflicts?.length ? 1 : 0;
    } catch (error) {
      const normalized = normalizeError(error);
      emit({ error: { code: normalized.code, message: normalized.message, details: normalized.details } }, flags, io);
      return normalized.code === "INTERNAL_ERROR" ? 2 : 1;
    }
  }

  let db = null;
  try {
    const bootstrap = positionals[0] === "init" || positionals[0] === "attach";
    const config = bootstrap ? null : loadConfig(projectRoot);
    if (bootstrap) {
      const value = await dispatch(positionals, flags, { projectRoot, config, db: null });
      emit(value, flags, io);
      return 0;
    }
    db = openDatabase(projectRoot);
    const value = await dispatch(positionals, flags, { projectRoot, config, db });
    emit(value, flags, io);
    return 0;
  } catch (error) {
    const normalized = normalizeError(error);
    const payload = { error: { code: normalized.code, message: normalized.message, details: normalized.details } };
    io.stderr.write(`${flags.pretty ? JSON.stringify(payload, null, 2) : stableStringify(payload)}\n`);
    return normalized.code === "INTERNAL_ERROR" ? 2 : 1;
  } finally {
    if (db) db.close();
  }
}

let invokedPath = null;
if (process.argv[1]) {
  try {
    invokedPath = pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    invokedPath = pathToFileURL(path.resolve(process.argv[1])).href;
  }
}
if (invokedPath === import.meta.url) process.exitCode = await main();
