---
name: browser-testing
description: Verify browser flows with assertions, screenshots, console output, and network results.
---

# Browser testing capability

Use the registered browser scenario as the contract.

1. Start only the required local application services.
2. Run the exact user actions for the declared viewport.
3. Emit one JSON result with actions, assertions, screenshots, console errors, and network failures.
4. Store screenshots below the repository before Metis ingests them.
5. Do not modify source, tests, or configuration during verification.
6. Treat a console error, network failure, failed assertion, or source mutation as a failure.

The installed verifier is `.agents/metis/runtime/scripts/chromium-browser-verifier.mjs`.
Use it when a Chromium-compatible executable is available.
Set `METIS_CHROMIUM` only when automatic discovery fails.
