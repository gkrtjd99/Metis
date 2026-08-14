# Contracts and Traceability

The Goal Contract is the stable authority for one run.
Conversation history is not the contract.

## Goal Contract

The contract contains:

- objective;
- scope;
- non-goals;
- constraints;
- measurable success criteria;
- complexity;
- lifecycle route;
- atomic requirements with acceptance criteria.

Freeze it during intake:

```sh
metis contract freeze --data '<json>' --pretty
```

Use an explicit amendment for material changes:

```sh
metis contract amend --data '<json>' --pretty
```

A material amendment needs `approvedByUser: true`.
It invalidates dependent discovery, design, plan, Task Packets, review, verification, and knowledge state.

## Requirements

Use stable IDs such as `REQ-AUTH-001`.
Use one priority: `must`, `should`, or `could`.
Do not combine independent requirements in one record.

Requirement kinds include functional, UI, security, database, migration, accessibility, and performance work.
Kinds help capability routing.
A task title alone must not select a capability.

## Interface contracts

Parallel tasks must consume frozen shared boundaries.
An interface contract can define a function, API, event, record, UI state, or file exchange.

Only a frozen interface can bind to a task.
A new frozen version supersedes the previous version and makes linked Task Packets stale.
A worker can report a conflict.
It cannot silently change the frozen interface.

## Task blueprint and Task Packet

The structured task blueprint is the source of truth.
The Task Packet is its executable projection.

Protected task fields include:

- scope and mutable paths;
- dependencies;
- authority;
- acceptance criteria;
- frozen interfaces.

A task-compiler can clarify execution but cannot change protected fields.
An unresolved ambiguity blocks dispatch.

## Traceability

Each must requirement must trace through applicable stages:

```text
requirement
  -> discovery or research evidence
  -> design or decision
  -> planned task and interface
  -> implementation evidence
  -> verification evidence
  -> documentation when required
```

Inspect current coverage:

```sh
metis trace report --pretty
```

A stale source, command, browser run, interface, packet, or artifact makes dependent evidence stale.

## Product evidence

UI requirements can require:

- `experience-contract`;
- `visual-contract`;
- `browser-acceptance`;
- current browser evidence;
- a conditional human-verification checkpoint.

Milestones need observable outcomes and exit criteria.
Tasks need task kind, wave, risk, effort, slice type, verification modes, capabilities, interfaces, and expected outputs.

## Governance

Record uncertain statements as assumptions.
Record enduring rules as invariants.
Record credible failure or delivery concerns as risks.
Record durable choices as decisions.

High-impact open assumptions block execution.
Violated critical invariants block completion.
Open critical risks need mitigation or explicit acceptance.
