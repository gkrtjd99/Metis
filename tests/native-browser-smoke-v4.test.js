import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import { registerBrowserScenario, runBrowserScenario } from "../src/core/browser.js";
import { readObject } from "../src/core/objects.js";
import { makeProject, nodeCommand, startTestRun } from "./helpers.js";

const verifierFile = fileURLToPath(new URL("../scripts/chromium-browser-verifier.mjs", import.meta.url));

function chromiumCommand() {
  for (const candidate of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]) {
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8", timeout: 3000 });
    if (probe.status === 0) return candidate;
  }
  return null;
}

test("configured browser evidence drives a real Chromium process when available", (context) => {
  const chromium = chromiumCommand();
  if (!chromium) {
    context.skip("Chromium is not installed in this environment.");
    return;
  }

  const { root, config, db } = makeProject();
  try {
    const { run } = startTestRun(db, root, config, "Verify a real browser flow", {
      contract: {
        requirements: [{
          id: "REQ-BROWSER",
          title: "Browser smoke flow",
          description: "A real browser loads the page and activates its primary interaction.",
          kind: "ui",
          priority: "must",
          acceptance: ["The Chromium smoke scenario passes."]
        }]
      }
    });

    const specFile = path.join(root, "browser-smoke-spec.json");
    writeFileSync(specFile, JSON.stringify({
      documentHtml: `<!doctype html>
        <html><body data-clicked="no">
          <button id="primary">Activate</button>
          <output id="result">pending</output>
          <script>
            document.getElementById("primary").addEventListener("click", () => {
              document.body.dataset.clicked = "yes";
              document.getElementById("result").textContent = "complete";
            });
          </script>
        </body></html>`,
      actions: [{ type: "click", selector: "#primary", waitAfterMs: 100 }],
      assertions: [
        { label: "primary-result", type: "text", selector: "#result", equals: "complete" },
        { label: "body-clicked-state", type: "attribute", selector: "body", attribute: "data-clicked", equals: "yes" }
      ],
      screenshot: ".metis/tmp/native-browser-smoke.png",
      timeoutMs: 30_000
    }, null, 2));

    registerBrowserScenario(db, run.id, {
      name: "native-chromium-smoke",
      url: "https://metis.invalid/browser-smoke",
      viewport: { width: 390, height: 844 },
      requirementIds: ["REQ-BROWSER"],
      command: nodeCommand([verifierFile, specFile], {
        env: { METIS_CHROMIUM: chromium },
        timeoutMs: 60_000
      })
    });

    const result = runBrowserScenario(db, root, run.id, "native-chromium-smoke", config);
    assert.equal(result.evidence.status, "passed", result.preview);
    assert.equal(result.evidence.assertions.length, 2);
    assert.ok(result.evidence.assertions.every((item) => item.pass));
    assert.equal(result.evidence.screenshotRefs.length, 1);
    const png = readObject(db, root, result.evidence.screenshotRefs[0]);
    assert.ok(Buffer.isBuffer(png));
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  } finally {
    db.close();
  }
});
