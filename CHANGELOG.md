# Changelog

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
