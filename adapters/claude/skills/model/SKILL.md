---
name: model
description: Interactively configure Metis Main expectations and subagent model/effort routing for the current project. Use only when the user explicitly invokes $metis:model or asks Metis to choose, change, show, or reset its model configuration.
---

# Configure Metis models

Configure model routing only. Do not estimate or display cost.

Resolve the launcher from this loaded `SKILL.md` directory:

```sh
node --no-warnings <skill-directory>/../metis/scripts/metis.mjs
```

Installed project copies may replace that command with an absolute launcher.

## Workflow

1. Resolve the explicit or enclosing Git project root. Do not scan repository source.
2. Run `model show --pretty` with the launcher and root.
3. Use only host-provided session metadata to identify the current Main model and effort. Never invent a model catalog or capability list.
4. Explain that Main is controlled by the active host. If the user wants to change Main and the host exposes `/model`, ask them to make that selection first; do not claim that Metis switched Main.
5. Ask for the subagent default model. Ask about ordinary/strong groups or role overrides only when the user wants different routing.
6. Ask for effort only when the host exposes it. Record supported-effort capability evidence only when the host explicitly provides it.
7. Show the final Main expectation and subagent routes without cost estimates. Obtain confirmation before changing project config.
8. Write this bounded JSON shape to a temporary file under `.metis/`, invoke `model configure --file <file> --pretty`, then remove only that temporary input file after success:

```json
{
  "host": "codex",
  "main": { "model": "main-model", "effort": "xhigh" },
  "subagents": {
    "default": { "model": "worker-model", "effort": "high" },
    "ordinary": { "model": "worker-model", "effort": "medium" },
    "strong": { "model": "strong-model", "effort": "xhigh" }
  },
  "roles": {
    "reviewer": { "model": "review-model", "effort": "xhigh" }
  },
  "capabilities": {
    "worker-model": ["low", "medium", "high"]
  }
}
```

Omit unselected fields. `subagents.default` applies to every role, group values override it, and `roles` override groups. A null model restores host selection for that route. If capability evidence is absent, preserve the requested effort as deferred and let the host adapter negotiate it.

Model configuration is frozen while a run is active or blocked. If configuration returns `MODEL_CONFIG_ACTIVE_RUN`, stop and tell the user to complete the run before changing the next goal's routes. Do not bypass this boundary.

For a reset request, show current routing, confirm, then run `model reset --yes --pretty`.

## Output

Return the saved host, Main expectation, default/group/role model routes, and any deferred-capability warnings. Never report projected price or token cost.
