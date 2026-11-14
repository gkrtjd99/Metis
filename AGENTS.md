# Metis Repository Rules

Use Node.js 22.16.0 or newer.
Do not add a runtime dependency without a demonstrated need.
Keep the core host-neutral.
Keep host-specific files under adapters or plugin surfaces.
Do not place raw worker output in Main context.
Preserve task and result contracts across adapters.
Do not add compatibility code for obsolete schemas.
Choose verification by scope; task and goal contracts plus required instructions take precedence. Widen verification when scope is uncertain.
For documentation or link-only changes, use static content, link, and mirror checks.
For localized code changes, run affected tests first.
For runtime, CLI, contract, security, concurrency, or packaging changes, run the full `npm run check`.
Avoid repeating the full suite against the same final state unless there is a new change, a new failure hypothesis, or an external requirement.
Before relying on prior evidence, establish current source, command, inputs, configuration, and environment; unchanged source alone is insufficient. If freshness cannot be established, execute or verify again.
Never waive independent verification, evidence freshness, or any registered required check. Preserve final CI and release gates.
