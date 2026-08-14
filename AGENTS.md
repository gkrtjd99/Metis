# Metis Repository Rules

Use Node.js 22.16.0 or newer.
Do not add a runtime dependency without a demonstrated need.
Keep the core host-neutral.
Keep host-specific files under adapters or plugin surfaces.
Do not place raw worker output in Main context.
Preserve task and result contracts across adapters.
Do not add compatibility code for obsolete schemas.
Run `npm run check` after changes.
