# Curation and Knowledge

Curation converts verified final behavior into durable project knowledge.
Main does not write the documentation itself.
A curator subagent receives one bounded Task Packet.

## Documentation impact

Review changes that affect:

- public API or CLI behavior;
- configuration and schema;
- architecture boundaries;
- operational procedures;
- security behavior;
- user workflows;
- durable design decisions.

Update human documentation only from current evidence.
Record a justified no-change disposition when an affected document does not need an edit.

## Curator boundary

The curator can use:

- verified final behavior;
- active decisions;
- current interfaces;
- current traceability;
- declared documentation paths.

The curator must not:

- infer design intent from code alone;
- modify implementation code;
- change product behavior;
- hand-edit generated indexes;
- use stale child output.

## Generated indexes

Regenerate these artifacts instead of editing them by hand:

- repository index;
- symbol index;
- dependency index;
- document index;
- knowledge index;
- project index summary;
- project knowledge summary.

Generated indexes describe current structure.
They do not explain why a design exists.

## ADR proposals

Active durable decisions can produce ADR proposals.
A proposal is not an accepted ADR.
Review it before promoting it to human-authored documentation.

## Stale knowledge

Source changes can stale findings, decisions, checks, trace links, reviews, Task Packets, and knowledge synchronization.
Re-read current evidence.
Replace, resolve, or revalidate stale records.
No stale must-requirement evidence can remain at completion.

## Final curation

Run after the curator result is integrated:

```sh
metis trace report --pretty
metis knowledge sync --pretty
metis evaluate --pretty
```

The self-evaluation records orchestration quality, wave structure, compiler use, retries, diagnoses, reopens, stalls, context quality, budget use, review findings, and traceability.
It improves Metis without becoming project design authority.
