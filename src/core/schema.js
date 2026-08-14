export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  goal TEXT NOT NULL,
  goal_hash TEXT NOT NULL,
  controller TEXT NOT NULL DEFAULT 'metis',
  controller_session_id TEXT NOT NULL,
  controller_owner TEXT NOT NULL,
  controller_fencing_token INTEGER NOT NULL DEFAULT 1,
  controller_token TEXT NOT NULL,
  controller_expires_at TEXT NOT NULL,
  phase TEXT NOT NULL,
  status TEXT NOT NULL,
  host TEXT NOT NULL,
  approval_policy TEXT NOT NULL,
  project_root TEXT NOT NULL,
  baseline_ref TEXT,
  current_milestone_id TEXT,
  contract_version INTEGER NOT NULL DEFAULT 0,
  complexity TEXT NOT NULL DEFAULT 'standard',
  route_json TEXT NOT NULL DEFAULT '{}',
  revision INTEGER NOT NULL DEFAULT 1,
  stalled_count INTEGER NOT NULL DEFAULT 0,
  last_progress_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_one_live ON runs(project_root) WHERE status IN ('active','blocked');

CREATE TABLE IF NOT EXISTS goal_contracts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  objective TEXT NOT NULL,
  scope_json TEXT NOT NULL DEFAULT '[]',
  non_goals_json TEXT NOT NULL DEFAULT '[]',
  constraints_json TEXT NOT NULL DEFAULT '[]',
  success_criteria_json TEXT NOT NULL DEFAULT '[]',
  complexity TEXT NOT NULL DEFAULT 'standard',
  route_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  parent_version INTEGER,
  amendment_reason TEXT,
  approved_by_user INTEGER NOT NULL DEFAULT 0,
  contract_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(run_id, version)
);
CREATE INDEX IF NOT EXISTS idx_contracts_run_status ON goal_contracts(run_id, status, version DESC);

CREATE TABLE IF NOT EXISTS requirements (
  id TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'functional',
  priority TEXT NOT NULL DEFAULT 'must',
  status TEXT NOT NULL DEFAULT 'active',
  acceptance_json TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'goal-contract',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(run_id, id)
);
CREATE INDEX IF NOT EXISTS idx_requirements_run_status ON requirements(run_id, status, priority);

CREATE TABLE IF NOT EXISTS trace_links (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  requirement_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'current',
  evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(run_id, requirement_id, target_type, target_id, relation),
  FOREIGN KEY(run_id, requirement_id) REFERENCES requirements(run_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_trace_requirement ON trace_links(run_id, requirement_id, relation, status);
CREATE INDEX IF NOT EXISTS idx_trace_target ON trace_links(run_id, target_type, target_id);

CREATE TABLE IF NOT EXISTS milestones (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES milestones(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  sequence INTEGER NOT NULL DEFAULT 1,
  acceptance_json TEXT NOT NULL DEFAULT '[]',
  entry_criteria_json TEXT NOT NULL DEFAULT '[]',
  exit_criteria_json TEXT NOT NULL DEFAULT '[]',
  user_visible_outcome TEXT NOT NULL,
  requirement_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_milestones_run_sequence ON milestones(run_id, sequence, created_at);

CREATE TABLE IF NOT EXISTS milestone_dependencies (
  milestone_id TEXT NOT NULL REFERENCES milestones(id) ON DELETE CASCADE,
  depends_on TEXT NOT NULL REFERENCES milestones(id) ON DELETE CASCADE,
  PRIMARY KEY(milestone_id, depends_on),
  CHECK(milestone_id <> depends_on)
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id TEXT,
  kind TEXT NOT NULL,
  path TEXT,
  status TEXT NOT NULL,
  content_ref TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_run_kind ON artifacts(run_id, kind, status);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  milestone_id TEXT REFERENCES milestones(id) ON DELETE SET NULL,
  parent_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  delegation_depth INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  goal TEXT NOT NULL,
  role TEXT NOT NULL,
  task_kind TEXT NOT NULL DEFAULT 'implementation',
  wave INTEGER NOT NULL DEFAULT 1,
  phase TEXT NOT NULL,
  status TEXT NOT NULL,
  contract_status TEXT NOT NULL DEFAULT 'draft',
  contract_policy TEXT NOT NULL DEFAULT 'deterministic',
  compiler_target_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  compiled_packet_id TEXT,
  priority INTEGER NOT NULL DEFAULT 50,
  read_only INTEGER NOT NULL DEFAULT 0,
  complexity TEXT NOT NULL DEFAULT 'medium',
  risk TEXT NOT NULL DEFAULT 'medium',
  effort TEXT NOT NULL DEFAULT 'medium',
  slice_type TEXT NOT NULL DEFAULT 'vertical',
  verification_modes_json TEXT NOT NULL DEFAULT '[]',
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  model_tier TEXT NOT NULL DEFAULT 'worker',
  selected_model TEXT,
  model_source TEXT NOT NULL DEFAULT 'none' CHECK(model_source IN ('none','task','role','host-default','escalation')),
  requested_effort TEXT NOT NULL DEFAULT 'medium',
  effective_effort TEXT,
  effort_source TEXT NOT NULL DEFAULT 'persisted',
  supported_efforts_json TEXT NOT NULL DEFAULT '[]',
  capability_status TEXT NOT NULL DEFAULT 'known',
  reasoning_effort TEXT DEFAULT 'medium',
  escalation_level INTEGER NOT NULL DEFAULT 0,
  escalation_cause TEXT,
  failure_class TEXT,
  transient_retry_count INTEGER NOT NULL DEFAULT 0,
  workspace_mode TEXT NOT NULL DEFAULT 'shared',
  scope_json TEXT NOT NULL DEFAULT '[]',
  non_goals_json TEXT NOT NULL DEFAULT '[]',
  constraints_json TEXT NOT NULL DEFAULT '[]',
  target_paths_json TEXT NOT NULL DEFAULT '[]',
  interfaces_json TEXT NOT NULL DEFAULT '[]',
  interface_inputs_json TEXT NOT NULL DEFAULT '[]',
  interface_outputs_json TEXT NOT NULL DEFAULT '[]',
  context_refs_json TEXT NOT NULL DEFAULT '[]',
  stop_conditions_json TEXT NOT NULL DEFAULT '[]',
  expected_outputs_json TEXT NOT NULL DEFAULT '[]',
  acceptance_json TEXT NOT NULL DEFAULT '[]',
  required_evidence_json TEXT NOT NULL DEFAULT '[]',
  requirement_ids_json TEXT NOT NULL DEFAULT '[]',
  specialist TEXT,
  review_kind TEXT,
  auto_generated INTEGER NOT NULL DEFAULT 0,
  progress_weight REAL NOT NULL DEFAULT 1,
  authority TEXT NOT NULL DEFAULT 'local-read',
  result_json TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  attempt_fence INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 2,
  owner TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_run_status ON tasks(run_id, status, priority);
CREATE INDEX IF NOT EXISTS idx_tasks_milestone ON tasks(milestone_id, status, priority);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id, status, priority);

CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY(task_id, depends_on),
  CHECK(task_id <> depends_on)
);

-- Append-only execution-attempt provenance. A task row represents the
-- current route; this ledger preserves every fenced execution attempt.
CREATE TABLE IF NOT EXISTS task_attempts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  attempt_fence INTEGER NOT NULL,
  attempt_number INTEGER NOT NULL,
  host TEXT NOT NULL,
  role TEXT NOT NULL,
  tier TEXT NOT NULL,
  selected_model TEXT,
  model_source TEXT NOT NULL,
  requested_effort TEXT,
  effective_effort TEXT,
  effort_source TEXT,
  supported_efforts_json TEXT NOT NULL DEFAULT '[]',
  capability_status TEXT NOT NULL DEFAULT 'known',
  reasoning_escalation_level INTEGER NOT NULL DEFAULT 0,
  failure_class TEXT,
  failure_cause TEXT,
  escalation_cause TEXT,
  spawn_batch_id TEXT REFERENCES scheduler_batches(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'running',
  start_at TEXT NOT NULL,
  spawn_accepted_at TEXT,
  execution_started_at TEXT,
  execution_ended_at TEXT,
  terminal_at TEXT,
  UNIQUE(task_id, attempt_fence)
);
CREATE INDEX IF NOT EXISTS idx_task_attempts_task ON task_attempts(task_id, attempt_number, start_at);
CREATE INDEX IF NOT EXISTS idx_task_attempts_run ON task_attempts(run_id, start_at);

CREATE TABLE IF NOT EXISTS leases (
  resource TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  fencing_token INTEGER NOT NULL,
  owner TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(resource, task_id)
);
CREATE INDEX IF NOT EXISTS idx_leases_expires ON leases(expires_at);

CREATE TABLE IF NOT EXISTS worktrees (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  attempt_fence INTEGER NOT NULL,
  path TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  base_ref TEXT,
  baseline_ref TEXT,
  patch_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(task_id, attempt_fence)
);
CREATE INDEX IF NOT EXISTS idx_worktrees_run_status ON worktrees(run_id, status);

CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  source_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  claim TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'fact',
  confidence REAL NOT NULL DEFAULT 1,
  relevance TEXT,
  severity TEXT NOT NULL DEFAULT 'info',
  status TEXT NOT NULL DEFAULT 'valid',
  sources_json TEXT NOT NULL DEFAULT '[]',
  requirement_ids_json TEXT NOT NULL DEFAULT '[]',
  target_paths_json TEXT NOT NULL DEFAULT '[]',
  suggested_fix TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_findings_run_status ON findings(run_id, status, severity);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  decision TEXT NOT NULL,
  rationale TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  watch_refs_json TEXT NOT NULL DEFAULT '[]',
  requirement_ids_json TEXT NOT NULL DEFAULT '[]',
  affects_json TEXT NOT NULL DEFAULT '[]',
  review_after TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decisions_run_status ON decisions(run_id, status);

CREATE TABLE IF NOT EXISTS assumptions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  statement TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  impact TEXT NOT NULL DEFAULT 'medium',
  severity TEXT NOT NULL DEFAULT 'warning',
  status TEXT NOT NULL DEFAULT 'open',
  evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  validation_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  disposition TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assumptions_run_status ON assumptions(run_id, status, impact);

CREATE TABLE IF NOT EXISTS invariants (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'error',
  status TEXT NOT NULL DEFAULT 'active',
  evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  verification_refs_json TEXT NOT NULL DEFAULT '[]',
  requirement_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invariants_run_status ON invariants(run_id, status, severity);

CREATE TABLE IF NOT EXISTS risks (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'warning',
  likelihood TEXT NOT NULL DEFAULT 'possible',
  status TEXT NOT NULL DEFAULT 'open',
  mitigation TEXT,
  disposition TEXT,
  owner TEXT,
  evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  verification_refs_json TEXT NOT NULL DEFAULT '[]',
  requirement_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_risks_run_status ON risks(run_id, status, severity);

CREATE TABLE IF NOT EXISTS review_findings (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  reviewer_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  review_kind TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'warning',
  status TEXT NOT NULL DEFAULT 'open',
  target_paths_json TEXT NOT NULL DEFAULT '[]',
  requirement_ids_json TEXT NOT NULL DEFAULT '[]',
  evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  suggested_fix TEXT,
  repair_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  disposition TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_review_findings_run ON review_findings(run_id, review_kind, status, severity);

CREATE TABLE IF NOT EXISTS checks (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  command_json TEXT NOT NULL,
  command_hash TEXT,
  required INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending',
  output_ref TEXT,
  exit_code INTEGER,
  code_fingerprint TEXT,
  requirement_ids_json TEXT NOT NULL DEFAULT '[]',
  invariant_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(run_id, name)
);

CREATE TABLE IF NOT EXISTS document_impacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  disposition TEXT,
  evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  requirement_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(run_id, path, reason)
);

CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms REAL NOT NULL,
  ctime_ms REAL NOT NULL,
  kind TEXT NOT NULL,
  indexed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS objects (
  hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  compressed_bytes INTEGER NOT NULL,
  path TEXT NOT NULL,
  content_encoding TEXT NOT NULL DEFAULT 'utf8',
  encrypted INTEGER NOT NULL DEFAULT 1,
  cipher TEXT NOT NULL DEFAULT 'aes-256-gcm',
  nonce TEXT,
  auth_tag TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  payload_json TEXT NOT NULL DEFAULT '{}',
  fingerprint TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(run_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_events_run_updated ON events(run_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS journal (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  actor TEXT NOT NULL DEFAULT 'runtime',
  event_type TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  causation_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  state_hash TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_journal_run_sequence ON journal(run_id, sequence);

CREATE TABLE IF NOT EXISTS scheduler_batches (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  parent_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  phase TEXT NOT NULL,
  status TEXT NOT NULL,
  batch_json TEXT NOT NULL,
  rationale_json TEXT NOT NULL DEFAULT '[]',
  controller_fencing_token INTEGER NOT NULL,
  claimed_task_ids_json TEXT NOT NULL DEFAULT '[]',
  spawned_task_ids_json TEXT NOT NULL DEFAULT '[]',
  aborted_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scheduler_batches_run ON scheduler_batches(run_id, status, created_at DESC);


CREATE TABLE IF NOT EXISTS task_spawn_acks (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  attempt_fence INTEGER NOT NULL,
  batch_id TEXT REFERENCES scheduler_batches(id) ON DELETE SET NULL,
  owner TEXT NOT NULL,
  host_receipt TEXT,
  acknowledged_at TEXT NOT NULL,
  PRIMARY KEY(task_id, attempt_fence)
);

CREATE TABLE IF NOT EXISTS integration_locks (
  name TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  owner_token TEXT NOT NULL,
  fencing_token INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS capabilities (
  name TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  review_role TEXT,
  skill_path TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_capabilities (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  capability_name TEXT NOT NULL REFERENCES capabilities(name) ON DELETE RESTRICT,
  reason TEXT NOT NULL,
  PRIMARY KEY(task_id, capability_name)
);

CREATE TABLE IF NOT EXISTS interface_contracts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft',
  description TEXT NOT NULL,
  schema_json TEXT NOT NULL DEFAULT '{}',
  requirement_ids_json TEXT NOT NULL DEFAULT '[]',
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(run_id, name, version)
);
CREATE INDEX IF NOT EXISTS idx_interface_contracts_run ON interface_contracts(run_id, status, name, version DESC);

CREATE TABLE IF NOT EXISTS task_interface_links (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  interface_id TEXT NOT NULL REFERENCES interface_contracts(id) ON DELETE RESTRICT,
  direction TEXT NOT NULL,
  allow_change INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(task_id, interface_id, direction)
);

CREATE TABLE IF NOT EXISTS task_packets (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  status TEXT NOT NULL,
  policy TEXT NOT NULL,
  blueprint_hash TEXT NOT NULL,
  packet_hash TEXT NOT NULL,
  packet_json TEXT NOT NULL,
  packet_ref TEXT,
  compiler_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(task_id, version)
);
CREATE INDEX IF NOT EXISTS idx_task_packets_task ON task_packets(task_id, status, version DESC);

CREATE TABLE IF NOT EXISTS checkpoints (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  milestone_id TEXT REFERENCES milestones(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  reason TEXT NOT NULL,
  blocking INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending',
  required_evidence_json TEXT NOT NULL DEFAULT '[]',
  resolution TEXT,
  resolved_by TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_checkpoints_run ON checkpoints(run_id, status, kind);

CREATE TABLE IF NOT EXISTS browser_scenarios (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  viewport_json TEXT NOT NULL DEFAULT '{}',
  command_json TEXT NOT NULL,
  requirement_ids_json TEXT NOT NULL DEFAULT '[]',
  required INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(run_id, name)
);

CREATE TABLE IF NOT EXISTS browser_evidence (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  scenario_id TEXT NOT NULL REFERENCES browser_scenarios(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  code_fingerprint TEXT NOT NULL,
  actions_hash TEXT,
  assertions_json TEXT NOT NULL DEFAULT '[]',
  screenshot_refs_json TEXT NOT NULL DEFAULT '[]',
  console_errors_json TEXT NOT NULL DEFAULT '[]',
  network_failures_json TEXT NOT NULL DEFAULT '[]',
  output_ref TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_browser_evidence_scenario ON browser_evidence(scenario_id, created_at DESC);

CREATE TABLE IF NOT EXISTS typed_evidence (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'current',
  payload_json TEXT NOT NULL DEFAULT '{}',
  content_ref TEXT,
  code_fingerprint TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_typed_evidence_run ON typed_evidence(run_id, type, status);

CREATE TABLE IF NOT EXISTS repository_scans (
  id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  file_limit INTEGER NOT NULL,
  discovered_files INTEGER,
  indexed_files INTEGER NOT NULL,
  truncated INTEGER NOT NULL,
  source TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_repository_scans_run ON repository_scans(run_id, created_at DESC);

CREATE TABLE IF NOT EXISTS repository_sync_leases (
  resource TEXT PRIMARY KEY,
  owner_token TEXT NOT NULL,
  fencing_token INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS budget_state (
  run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  input_token_limit INTEGER,
  output_token_limit INTEGER,
  tool_call_limit INTEGER,
  agent_spawn_limit INTEGER,
  research_call_limit INTEGER,
  wall_clock_limit_ms INTEGER,
  retry_limit INTEGER,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  agent_spawns INTEGER NOT NULL DEFAULT 0,
  research_calls INTEGER NOT NULL DEFAULT 0,
  retries INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS progress_samples (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  phase TEXT NOT NULL,
  revision INTEGER NOT NULL,
  metrics_json TEXT NOT NULL,
  delta_json TEXT NOT NULL,
  progressed INTEGER NOT NULL,
  stall_count INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(run_id, revision)
);
CREATE INDEX IF NOT EXISTS idx_progress_run ON progress_samples(run_id, revision DESC);

CREATE TABLE IF NOT EXISTS context_snapshots (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  model TEXT,
  token_budget INTEGER NOT NULL,
  estimated_tokens INTEGER NOT NULL,
  observed_tokens INTEGER,
  remaining_tokens INTEGER,
  token_method TEXT NOT NULL DEFAULT 'calibrated-estimate',
  content_hash TEXT NOT NULL,
  content_ref TEXT,
  quality_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_context_snapshots_run ON context_snapshots(run_id, created_at DESC);

CREATE TABLE IF NOT EXISTS usage_samples (
  id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  model TEXT,
  content_hash TEXT,
  estimated_tokens INTEGER,
  observed_input_tokens INTEGER,
  observed_output_tokens INTEGER,
  source TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_samples_model ON usage_samples(model, created_at DESC);

CREATE TABLE IF NOT EXISTS self_evaluations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  metrics_json TEXT NOT NULL,
  recommendations_json TEXT NOT NULL,
  content_ref TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_self_eval_run ON self_evaluations(run_id, created_at DESC);

CREATE TABLE IF NOT EXISTS benchmark_runs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  variant TEXT NOT NULL,
  scenario TEXT NOT NULL,
  status TEXT NOT NULL,
  duration_ms INTEGER,
  verification_status TEXT,
  changed_files INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  time_to_first_worker_ms INTEGER,
  max_concurrency INTEGER,
  slot_utilization REAL,
  retry_count INTEGER,
  host TEXT,
  model TEXT,
  policy TEXT,
  result_ref TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_benchmark_name ON benchmark_runs(name, variant, scenario, created_at DESC);
`;
