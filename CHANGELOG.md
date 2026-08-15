# Changelog

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
