import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Deterministic, local-only fixtures used by the required benchmark suite.
 *
 * The fixture tests and input artifacts are part of the contract.  Their
 * hashes are embedded in the generated verifier, rather than read from a
 * marker written by the worker being measured.
 */

const MODULE_FILE = fileURLToPath(import.meta.url);

const SCENARIO_NAMES = Object.freeze([
  "trivial-local-change",
  "four-slice-standard-change",
  "eight-slice-standard-change",
  "shared-interface-change",
  "reasoning-failure",
  "transient-failure",
  "contract-failure",
  "codex-host",
  "claude-host"
]);

export const BUILT_IN_BENCHMARK_SCENARIOS = Object.freeze(SCENARIO_NAMES.map((name) => Object.freeze({ name })));

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const fileHash = (file) => sha256(readFileSync(file));
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

function scenarioName(scenario) {
  const name = typeof scenario === "string" ? scenario : scenario?.name;
  if (!SCENARIO_NAMES.includes(name)) throw new TypeError(`Unknown built-in benchmark scenario: ${name ?? "(missing)"}`);
  return name;
}

function writeFile(workspace, relative, contents) {
  const file = path.join(workspace, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents, "utf8");
  return file;
}

function testFile(relative, contents) {
  return { relative, contents };
}

function sourceFile(relative, baseline, expected, check) {
  return { relative, baseline, expected, check };
}

function commonPackage(name) {
  return json({
    name: `metis-benchmark-${name}`,
    version: "1.0.0",
    private: true,
    type: "module",
    scripts: { test: "node --test tests/*.test.mjs" }
  });
}

function sliceFixture(count) {
  const sources = [];
  const tests = [];
  for (let index = 1; index <= count; index += 1) {
    const relative = `src/slice-${index}.js`;
    const testRelative = `tests/slice-${index}.test.mjs`;
    const exported = `slice${index}`;
    const before = `export function ${exported}() { return "slice-${index}-before"; }\n`;
    const after = `export function ${exported}() { return "slice-${index}-complete"; }\n`;
    sources.push(sourceFile(relative, before, after, { kind: "slice", index, exported }));
    tests.push(testFile(testRelative, `import assert from "node:assert/strict";\nimport test from "node:test";\nimport { ${exported} } from "../${relative}";\n\ntest("independent slice ${index} is complete", () => {\n  assert.equal(${exported}(), "slice-${index}-complete");\n});\n`));
  }
  return { sources, tests };
}

function sharedInterfaceFixture() {
  const interfaceDefinition = { version: 1, fields: ["id", "label"] };
  const interfaceHash = sha256(JSON.stringify(interfaceDefinition));
  const contract = `export const INTERFACE = Object.freeze({ version: 1, fields: Object.freeze(["id", "label"]) });\nexport const INTERFACE_HASH = "${interfaceHash}";\n`;
  const contractRecord = json({ ...interfaceDefinition, hash: interfaceHash });
  const consumerA = "import { INTERFACE_HASH } from \"./interface-contract.js\";\nexport function consumeA(record) { return INTERFACE_HASH + \":old:\" + record.label; }\n";
  const consumerAExpected = "import { INTERFACE_HASH } from \"./interface-contract.js\";\nexport function consumeA(record) { return INTERFACE_HASH + \":a:\" + record.label; }\n";
  const consumerB = "import { INTERFACE_HASH } from \"./interface-contract.js\";\nexport function consumeB(record) { return INTERFACE_HASH + \":old:\" + record.label; }\n";
  const consumerBExpected = "import { INTERFACE_HASH } from \"./interface-contract.js\";\nexport function consumeB(record) { return INTERFACE_HASH + \":b:\" + record.label; }\n";
  const test = "import assert from \"node:assert/strict\";\nimport test from \"node:test\";\nimport { INTERFACE, INTERFACE_HASH } from \"../src/interface-contract.js\";\nimport record from \"../src/interface-contract.json\" with { type: \"json\" };\nimport { consumeA } from \"../src/consumer-a.js\";\nimport { consumeB } from \"../src/consumer-b.js\";\n\ntest(\"consumers use the frozen interface\", () => {\n  assert.deepEqual(INTERFACE, { version: 1, fields: [\"id\", \"label\"] });\n  assert.equal(INTERFACE_HASH, record.hash);\n  assert.equal(consumeA({ id: \"r1\", label: \"Record\" }), INTERFACE_HASH + \":a:Record\");\n  assert.equal(consumeB({ id: \"r1\", label: \"Record\" }), INTERFACE_HASH + \":b:Record\");\n});\n";
  return {
    interfaceHash,
    sources: [
      sourceFile("src/consumer-a.js", consumerA, consumerAExpected, { kind: "consumer", exported: "consumeA", prefix: "a" }),
      sourceFile("src/consumer-b.js", consumerB, consumerBExpected, { kind: "consumer", exported: "consumeB", prefix: "b" })
    ],
    immutable: [
      { relative: "src/interface-contract.js", contents: contract },
      { relative: "src/interface-contract.json", contents: contractRecord }
    ],
    tests: [testFile("tests/shared-interface.test.mjs", test)]
  };
}

/**
 * The shared-interface benchmark deliberately exercises the managed contract
 * route rather than looking like a bounded local change. Keep this declaration
 * next to the fixture so the prompt and contract evidence cannot drift apart.
 */
const SHARED_INTERFACE_CONTRACT = Object.freeze({
  complexity: "standard",
  scope: Object.freeze(["src/consumer-a.js", "src/consumer-b.js"]),
  requirements: Object.freeze([
    Object.freeze({
      id: "REQ-CONSUMER-A",
      title: "Update consumer A",
      description: "Update consumer A to use the frozen interface contract and its required prefix.",
      kind: "functional",
      priority: "must",
      acceptance: Object.freeze(["consumer-a.js passes the supplied verifier"])
    }),
    Object.freeze({
      id: "REQ-CONSUMER-B",
      title: "Update consumer B",
      description: "Update consumer B to use the frozen interface contract and its required prefix.",
      kind: "functional",
      priority: "must",
      acceptance: Object.freeze(["consumer-b.js passes the supplied verifier"])
    })
  ]),
  sharedInterfaces: Object.freeze(["src/interface-contract.js", "src/interface-contract.json"]),
  route: Object.freeze({
    sharedInterfaceRequired: true
  })
});

/** Return the deterministic Goal Contract fields declared by a built-in task. */
export function builtInBenchmarkContract(scenario) {
  const name = scenarioName(scenario);
  if (name !== "shared-interface-change") return null;
  return {
    objective: "Update both consumers against the frozen interface contract.",
    complexity: SHARED_INTERFACE_CONTRACT.complexity,
    scope: [...SHARED_INTERFACE_CONTRACT.scope],
    requirements: SHARED_INTERFACE_CONTRACT.requirements.map((item) => ({ ...item, acceptance: [...item.acceptance] })),
    sharedInterfaces: [...SHARED_INTERFACE_CONTRACT.sharedInterfaces],
    route: { ...SHARED_INTERFACE_CONTRACT.route },
    nonGoals: ["Do not edit tests or contract artifacts."],
    constraints: ["Preserve the recorded interface hash.", "Run the supplied verifier."],
    successCriteria: ["Both consumers pass the supplied verifier while the frozen interface hash remains unchanged."]
  };
}

const POLICY_DATA = Object.freeze({
  "reasoning-failure": {
    input: { failureClass: "reasoning", requestedEffort: "high", maxAttempts: 3 },
    expected: { attempts: ["high", "xhigh", "max"] }
  },
  "transient-failure": {
    input: { failureClass: "transient", requestedEffort: "high", maxAttempts: 2 },
    expected: { attempts: ["high", "high"] }
  },
  "contract-failure": {
    input: { failureClass: "contract", requestedEffort: "high", maxAttempts: 2 },
    expected: { attempts: ["high"], blindRetry: false, requiresDecision: true }
  }
});

function policyFixture(name) {
  const data = POLICY_DATA[name];
  const input = json(data.input);
  const expected = json(data.expected);
  const before = `export function planAttempts(input) {\n  return { attempts: [input.requestedEffort, "xhigh"], blindRetry: true, requiresDecision: false };\n}\n`;
  const after = `export function planAttempts(input) {\n  if (input.failureClass === "reasoning") return { attempts: ["high", "xhigh", "max"] };\n  if (input.failureClass === "transient") return { attempts: ["high", "high"] };\n  if (input.failureClass === "contract") return { attempts: ["high"], blindRetry: false, requiresDecision: true };\n  return { attempts: [input.requestedEffort] };\n}\n`;
  const test = `import assert from "node:assert/strict";\nimport test from "node:test";\nimport { readFileSync } from "node:fs";\nimport { planAttempts } from "../src/retry-policy.js";\n\ntest("${name} policy is deterministic", () => {\n  const input = JSON.parse(readFileSync(new URL("../src/policy-input.json", import.meta.url), "utf8"));\n  assert.deepEqual(planAttempts(input), ${expected.trim()});\n});\n`;
  return {
    sources: [sourceFile("src/retry-policy.js", before, after, { kind: "policy", expected: data.expected })],
    immutable: [{ relative: "src/policy-input.json", contents: input }],
    tests: [testFile("tests/policy.test.mjs", test)],
    input: data.input,
    expected: data.expected
  };
}

const HOST_DATA = Object.freeze({
  "codex-host": { host: "codex", input: { host: "codex", requestedEffort: "xhigh" }, expected: { reasoning_effort: "xhigh" } },
  "claude-host": { host: "claude", input: { host: "claude", requestedEffort: "xhigh" }, expected: ["--effort", "xhigh"] }
});

function hostFixture(name) {
  const data = HOST_DATA[name];
  const before = `export function renderEffort(input) { return input.requestedEffort; }\n`;
  const after = `export function renderEffort(input) {\n  if (input.host === "codex") return { reasoning_effort: input.requestedEffort };\n  if (input.host === "claude") return ["--effort", input.requestedEffort];\n  throw new Error("Unsupported host");\n}\n`;
  const expected = JSON.stringify(data.expected);
  const test = `import assert from "node:assert/strict";\nimport test from "node:test";\nimport { readFileSync } from "node:fs";\nimport { renderEffort } from "../src/render-effort.js";\n\ntest("${name} renders the host effort contract", () => {\n  const input = JSON.parse(readFileSync(new URL("../src/adapter-input.json", import.meta.url), "utf8"));\n  assert.deepEqual(renderEffort(input), ${expected});\n});\n`;
  return {
    sources: [sourceFile("src/render-effort.js", before, after, { kind: "host", host: data.host, expected: data.expected })],
    immutable: [{ relative: "src/adapter-input.json", contents: json(data.input) }],
    tests: [testFile("tests/host-rendering.test.mjs", test)],
    input: data.input,
    expected: data.expected,
    host: data.host
  };
}

function fixtureDefinition(name) {
  if (name === "trivial-local-change") {
    return {
      prompt: "Implement the bounded local change in src/value.js so answer() returns 42. For a managed Goal Contract, use lifecycleProfile \"fast\", complexity \"trivial\", scope [\"src/value.js\"], and exactly one functional must requirement for answer() returning 42. Record the file boundary and supplied verifier under constraints and success criteria, not as extra requirements. Do not edit tests or contract artifacts. Run the supplied verifier after the source change.",
      sources: [sourceFile("src/value.js", "export function answer() { return 41; }\n", "export function answer() { return 42; }\n", { kind: "trivial", exported: "answer", expected: 42 })],
      tests: [testFile("tests/value.test.mjs", "import assert from \"node:assert/strict\";\nimport test from \"node:test\";\nimport { answer } from \"../src/value.js\";\n\ntest(\"answer is updated\", () => { assert.equal(answer(), 42); });\n")]
    };
  }
  if (name === "four-slice-standard-change" || name === "eight-slice-standard-change") {
    const count = name.startsWith("four") ? 4 : 8;
    return { prompt: `Implement all ${count} independent source slices (src/slice-1.js through src/slice-${count}.js) so each returns its complete value. Do not edit tests or contract artifacts. Run the supplied verifier after every source slice is complete.`, ...sliceFixture(count) };
  }
  if (name === "shared-interface-change") {
    const fixture = sharedInterfaceFixture();
    const contract = builtInBenchmarkContract(name);
    return {
      prompt: `Implement src/consumer-a.js and src/consumer-b.js against the frozen interface in src/interface-contract.js. For a managed Goal Contract, use lifecycleProfile "balanced", complexity "${contract.complexity}", scope ${JSON.stringify(contract.scope)}, exactly two functional must requirements ${JSON.stringify(contract.requirements)}, sharedInterfaceRequired true, and sharedInterfaces ${JSON.stringify(contract.sharedInterfaces)}. Preserve the recorded interface hash and do not edit tests or contract artifacts. Run the supplied verifier.`,
      ...fixture,
      contractInput: contract
    };
  }
  if (POLICY_DATA[name]) {
    return { prompt: `Implement the deterministic ${name} retry policy in src/retry-policy.js using src/policy-input.json. The expected attempts are part of the input contract; do not edit tests or input artifacts, and do not use network access. Run the supplied verifier.`, ...policyFixture(name) };
  }
  const fixture = hostFixture(name);
  return { prompt: `Implement the ${fixture.host} adapter rendering in src/render-effort.js. Read the deterministic input artifact and render the exact host effort contract; do not edit tests or input artifacts or use network access. Run the supplied verifier.`, ...fixture };
}

/** Return the exact bounded task prompt without creating a workspace. */
export function builtInBenchmarkPrompt(scenario) {
  const definition = fixtureDefinition(scenarioName(scenario));
  return `Run this bounded benchmark task directly in the fixture workspace. ${definition.prompt}`;
}

function initializeGit(workspace) {
  const check = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: workspace, encoding: "utf8" });
  if (check.status !== 0) {
    const initialized = spawnSync("git", ["init", "-q"], { cwd: workspace, encoding: "utf8" });
    if (initialized.status !== 0) throw new Error("Unable to initialize fixture git repository: " + (initialized.stderr || initialized.error));
  }
  spawnSync("git", ["add", "-A"], { cwd: workspace, encoding: "utf8" });
  spawnSync("git", ["-c", "user.name=Metis", "-c", "user.email=metis@local", "commit", "-qm", "benchmark fixture baseline", "--allow-empty"], { cwd: workspace, encoding: "utf8" });
  primeGitWorktreeAdministration(workspace);
}

/**
 * Git creates the worktree administration directory lazily on the first
 * `worktree add`.  Benchmark hosts may be unable to create a leading hidden
 * directory from inside the host process, so materialize it while preparing
 * the fixture (before handing the workspace to a host).
 */
export function primeGitWorktreeAdministration(workspace) {
  const result = spawnSync("git", ["rev-parse", "--git-path", "worktrees"], { cwd: workspace, encoding: "utf8" });
  if (result.status !== 0) throw new Error("Unable to locate Git worktree administration: " + (result.stderr || result.error));
  const adminPath = result.stdout.trim();
  if (!adminPath) throw new Error("Git did not return a worktree administration path.");
  mkdirSync(path.isAbsolute(adminPath) ? adminPath : path.resolve(workspace, adminPath), { recursive: true, mode: 0o700 });
  return path.isAbsolute(adminPath) ? adminPath : path.resolve(workspace, adminPath);
}

function pathExistsOrThrow(workspace, relative) {
  const file = path.join(workspace, relative);
  if (!existsSync(file)) throw new Error(`Fixture contract file is missing: ${relative}`);
  return file;
}

function buildBenchmarkEvaluator(serialized, readableWorkspace, token) {
  return [
    "import { readFileSync } from \"node:fs\";",
    "import path from \"node:path\";",
    "import { pathToFileURL } from \"node:url\";",
    "const contract = " + serialized + ";",
    "const workspace = " + JSON.stringify(readableWorkspace) + ";",
    "const success = " + JSON.stringify(token) + ";",
    "const write = process.stdout.write.bind(process.stdout);",
    "const load = (relative) => import(pathToFileURL(path.join(workspace, relative)).href + \"?verify=\" + Math.random());",
    "for (const item of contract.behavior) {",
    "  if (item.kind === \"trivial\") { const { answer } = await load(\"src/value.js\"); if (answer() !== 42) throw new Error(\"answer() did not return 42\"); }",
    "  else if (item.kind === \"slice\") { const module = await load(\"src/slice-\" + item.index + \".js\"); if (module[item.exported]() !== \"slice-\" + item.index + \"-complete\") throw new Error(\"slice is incomplete\"); }",
    "  else if (item.kind === \"consumer\") { const module = await load(\"src/\" + (item.exported === \"consumeA\" ? \"consumer-a\" : \"consumer-b\") + \".js\"); if (module[item.exported]({ id: \"r1\", label: \"Record\" }) !== item.interfaceHash + \":\" + item.prefix + \":Record\") throw new Error(\"consumer does not honor frozen interface\"); }",
    "  else if (item.kind === \"policy\") { const { planAttempts } = await load(\"src/retry-policy.js\"); const input = JSON.parse(readFileSync(path.join(workspace, \"src/policy-input.json\"), \"utf8\")); if (JSON.stringify(planAttempts(input)) !== JSON.stringify(item.expected)) throw new Error(\"policy output is incorrect\"); }",
    "  else if (item.kind === \"host\") { const { renderEffort } = await load(\"src/render-effort.js\"); const input = JSON.parse(readFileSync(path.join(workspace, \"src/adapter-input.json\"), \"utf8\")); if (JSON.stringify(renderEffort(input)) !== JSON.stringify(item.expected)) throw new Error(\"host rendering is incorrect\"); }",
    "  else throw new Error(\"Unknown behavior contract\");",
    "}",
    "write(success);"
  ].join("\n");
}

function runBenchmarkEvaluator(workspace, permissionFlag, readableWorkspace, evaluator) {
  return spawnSync(process.execPath, [permissionFlag, "--allow-fs-read=" + readableWorkspace, "--input-type=module"], {
    cwd: workspace,
    encoding: "utf8",
    input: evaluator,
    timeout: 30000,
    env: {}
  });
}

async function verifyContract(workspace, name, contract, options = {}) {
  for (const [relative, hash] of Object.entries(contract.immutableHashes)) {
    const file = pathExistsOrThrow(workspace, relative);
    if (fileHash(file) !== hash) throw new Error(`Immutable benchmark artifact was changed: ${relative}`);
  }
  if (options.runTests !== false) {
    const permissionFlag = process.allowedNodeEnvironmentFlags.has("--permission") ? "--permission" : "--experimental-permission";
    const readableWorkspace = realpathSync.native(workspace);
    const token = randomBytes(24).toString("hex");
    const serialized = JSON.stringify({ behavior: contract.behavior });
    const evaluator = buildBenchmarkEvaluator(serialized, readableWorkspace, token);
    const result = runBenchmarkEvaluator(workspace, permissionFlag, readableWorkspace, evaluator);
    if (result.status !== 0 || result.error || result.stdout !== token) throw new Error("Fixture behavior failed: " + (result.stderr || result.error || result.stdout));
  }
  // Defense in depth: permission-restricted tests cannot write, and a second
  // hash check also catches any external mutation during the verification.
  for (const [relative, hash] of Object.entries(contract.immutableHashes)) {
    if (fileHash(pathExistsOrThrow(workspace, relative)) !== hash) throw new Error(`Immutable benchmark artifact changed during verification: ${relative}`);
  }
  return { passed: true, scenario: name };
}

/**
 * Materialize one of the nine deterministic benchmark projects.
 *
 * The returned command is safe to run with cwd set to `workspace`; it does
 * not need npm installation, network access, or a success marker file.
 */
export function prepareBuiltInBenchmarkFixture(workspace, scenario) {
  const root = path.resolve(workspace);
  const name = scenarioName(scenario);
  const definition = fixtureDefinition(name);
  const prompt = `Run this bounded benchmark task directly in the fixture workspace. ${definition.prompt}`;
  mkdirSync(root, { recursive: true });
  writeFile(root, "package.json", commonPackage(name));
  for (const file of definition.sources ?? []) writeFile(root, file.relative, file.baseline);
  for (const file of definition.immutable ?? []) writeFile(root, file.relative, file.contents);
  for (const file of definition.tests ?? []) writeFile(root, file.relative, file.contents);

  const immutable = [...(definition.tests ?? []), ...(definition.immutable ?? [])];
  const immutableHashes = Object.fromEntries(immutable.map((file) => [file.relative, fileHash(path.join(root, file.relative))]));
  const behavior = (definition.sources ?? []).map((file) => ({ ...file.check, ...(file.check?.kind === "consumer" ? { interfaceHash: definition.interfaceHash } : {}) }));
  const testFiles = (definition.tests ?? []).map((file) => file.relative);
  const contract = { name, immutableHashes, behavior, testFiles };
  initializeGit(root);
  const verifier = { command: process.execPath, args: [MODULE_FILE, "--verify", root, name], cwd: root };
  return {
    workspace: root,
    scenario: name,
    prompt,
    files: [...(definition.sources ?? []), ...immutable].map((file) => file.relative),
    verifierFile: MODULE_FILE,
    verifierPath: MODULE_FILE,
    verifier,
    verify: [verifier],
    contract,
    metadata: {
      mutableFiles: (definition.sources ?? []).map((file) => ({ path: file.relative, baseline: file.baseline, expected: file.expected })),
      immutableFiles: immutable.map((file) => file.relative),
      testFiles,
      deterministic: true
    }
  };
}

/** Programmatic verifier for callers that already have a prepared fixture. */
export async function verifyBuiltInBenchmarkFixture(workspace, scenario) {
  const root = path.resolve(workspace);
  const name = scenarioName(scenario);
  const definition = fixtureDefinition(name);
  const immutable = [...(definition.tests ?? []), ...(definition.immutable ?? [])];
  const immutableHashes = Object.fromEntries(immutable.map((file) => [file.relative, sha256(file.contents)]));
  const behavior = (definition.sources ?? []).map((file) => ({ ...file.check, ...(file.check?.kind === "consumer" ? { interfaceHash: definition.interfaceHash } : {}) }));
  try {
    return await verifyContract(root, name, { immutableHashes, behavior, testFiles: (definition.tests ?? []).map((file) => file.relative) });
  } catch (error) {
    return { passed: false, scenario: name, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Apply the known deterministic solution for policy/adapter probe scenarios. */
export function solveBuiltInBenchmarkFixture(workspace, scenario) {
  const root = path.resolve(workspace);
  const name = scenarioName(scenario);
  const definition = fixtureDefinition(name);
  for (const file of definition.sources ?? []) writeFile(root, file.relative, file.expected);
  return { scenario: name, files: (definition.sources ?? []).map((file) => file.relative) };
}

/** Phase-A-only liveness instrumentation for the 1.0.0 baseline. It changes
 * no lifecycle, routing, model, or verification policy; it merely prevents a
 * normal multi-minute host turn from outliving the observer lease. */
export function prepareBaselineObservation(workspace) {
  const root = path.resolve(workspace);
  const file = path.join(root, ".metis", "config.json");
  const config = JSON.parse(readFileSync(file, "utf8"));
  config.controller = { ...(config.controller ?? {}), leaseSeconds: 600, heartbeatSeconds: 120 };
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return { workspace: root, controller: config.controller, instrumentation: "controller-lease-only" };
}

if (process.argv[1] && path.resolve(process.argv[1]) === MODULE_FILE && process.argv[2] === "--solve") {
  const [, , , workspace, scenario] = process.argv;
  console.log(JSON.stringify(solveBuiltInBenchmarkFixture(workspace, scenario)));
} else if (process.argv[1] && path.resolve(process.argv[1]) === MODULE_FILE && process.argv[2] === "--prepare-baseline") {
  const [, , , workspace] = process.argv;
  console.log(JSON.stringify(prepareBaselineObservation(workspace)));
} else if (process.argv[1] && path.resolve(process.argv[1]) === MODULE_FILE && process.argv[2] === "--verify") {
  const [, , , workspace, scenario] = process.argv;
  verifyBuiltInBenchmarkFixture(workspace, scenario).then((result) => {
    if (!result.passed) {
      console.error(result.error);
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify({ scenario: result.scenario, verified: true }));
  });
}
