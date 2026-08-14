# Context and Budget Policy

Main context is a bounded semantic projection of durable state.
It is not an append-only transcript.

## Main context

Always preserve:

- Goal Contract;
- must requirements;
- current phase and status;
- next controller action;
- active blockers;
- current task-wave summary;
- packet and interface status summaries;
- controller and heartbeat requirements;
- budget and progress state.

Compress optional detail before mandatory state.
Do not truncate structured JSON blindly.

## Keep outside Main

Externalize:

- source bodies;
- complete Task Packets;
- full patches;
- raw logs and test streams;
- screenshots;
- browser traces;
- child transcripts;
- detailed child artifacts.

Use typed references and content-addressed runtime objects.

## Child context

Each child receives one fresh context with one Task Packet.
Use `fork_turns: "none"` for Codex.
Do not pass the Main transcript or sibling history.

A packet can include:

- role protocol;
- selected repository or artifact context;
- frozen interfaces;
- upstream structured results;
- selected capability procedures;
- acceptance and verification rules;
- result schema.

If a compact host contract clips packet text, retain and load the packet object reference.

## Compiler context

A task-compiler receives the protected target blueprint and selected evidence.
It does not receive Main history.
It can clarify execution but cannot change protected fields.

Use deterministic packet assembly for ordinary work.
Spend compiler-model context only on complex or high-risk tasks.
Packet compilation can run in parallel before the execution wave.

## Structured child results

Do not copy child transcripts into Main.
Persist the declared result fields and object references.
Main needs summaries, blockers, decisions, wave state, and evidence status.

## Budget enforcement

The runtime tracks:

- observed input and output tokens;
- tool calls;
- acknowledged agent spawns;
- research calls;
- retries;
- wall-clock time.

Record host-observed usage:

```sh
metis usage add --data '<json>' --pretty
metis budget status --pretty
```

Observed tokens update the hard budget immediately.
A crossing sample is recorded before later work is blocked.
Do not rely only on the estimator.
Do not continue after a budget decision without explicit authority.

Packet compilation also enforces a hard worker-context ceiling. If the compiled
packet would exceed the host budget, the runtime keeps the structured packet
reference, emits a durable budget warning, and requires a smaller selected
context or an explicit budget decision; it must not silently truncate raw
worker output into Main.
