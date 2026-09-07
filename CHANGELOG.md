# Changelog

## 1.1.0 - 2026-09-07

Current public release.

- Added owner lifecycle commands for coordinators to claim, monitor, verify,
  and complete an approved direct-child subtree using task leases rather than
  Main controller credentials.
- Added the shared Claude/Codex host-relay path and versioned spawn ABI, with
  independent owner/worker/verifier receipt checks and attempt/controller fences.
- Route coordinators to the strong tier and eligible bounded children to the
  worker tier while preserving explicit model choices. Bound Main context by
  owner and apply global and per-owner concurrency limits.
- Keep `ownerExecution` off by default and require explicit capability evidence.
- Corrected a scanner false positive in a test-only lease token and synchronized
  plugin source metadata, command frontmatter, and packaged license/security files.
- Extended package conformance checks with offline installation, installed CLI
  initialization, and owner/relay runtime and security-document inclusion.
- Recorded the bounded Claude Code and Codex execution-stage evidence path:
  owner → worker → independent verifier → same-owner resume, with actual
  receipts, immutable test hash, and audited database state.
- Kept schema 11, configuration 6, and runtime layout 4 unchanged; no migration
  is required. Nested Agent execution is not claimed as automatic support.
- Full real-plan E2E, multi-owner real parallelism, failure recovery, and
  performance improvement remain unverified.

## 1.0.1 - 2026-08-15

Security and release-readiness hardening for the current release.

- Pinned the security scanner and supply-chain CI actions; added the npm
  lockfile, Dependabot configuration, and SECURITY policy.
- Added scanner-safe benchmark fixtures and prevented benchmark verifier
  children from inheriting the parent environment.
- Contained task IDs before filesystem use and retained detached worktrees and
  path ownership for mutable tasks.
- No performance gain is claimed; benchmark evidence remains separately
  measured and verification-gated.

## 1.0.0 - 2026-08-14

Initial public release of Metis.

### Included

- A host-neutral, subagent-first lifecycle for repository goals.
- Explicit `$metis` opt-in adapter previews for Codex, Claude Code, and
  OpenCode; native host E2E remains a release-environment requirement.
- Explicit `$metis:model` configuration for host-owned Main expectations and
  validated subagent model routes.
- Structured Goal Contracts, milestones, task graphs, frozen interfaces, and
  compiled Task Packets.
- Parallel task waves with controller ownership, leases, worktree isolation,
  serialized integration, and durable recovery.
- Independent design, review, verification, browser, specialist, and curation
  gates.
- Evidence, traceability, budget, progress, journal, performance, and benchmark
  reporting.
- Project-local host installation, generated reference documentation, and a
  Node.js 22.16.0+ runtime with no third-party runtime dependencies.
- A lightweight ESM public facade (`init(options)`) for macOS and Linux. The
  facade requires a Git project root and a recognized preview host, performs
  attachment without creating runtime database state, and exposes package
  metadata through `metis-orchestrator/package.json`.
