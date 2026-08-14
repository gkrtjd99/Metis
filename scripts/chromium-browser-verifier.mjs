#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";

const DEFAULT_TIMEOUT = 30_000;

function readSpec() {
  const file = process.argv[2];
  if (!file) return {};
  return JSON.parse(readFileSync(path.resolve(file), "utf8"));
}

function browserExecutable(spec) {
  const configured = process.env.METIS_CHROMIUM || spec.browserCommand;
  if (configured) return configured;
  for (const candidate of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]) {
    if (spawnSync(candidate, ["--version"], { stdio: "ignore", timeout: 3000 }).status === 0) return candidate;
  }
  throw new Error("No Chromium-compatible browser was found. Set METIS_CHROMIUM.");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}

async function startBrowser(executable, profile, timeoutMs, extraArgs = []) {
  const detached = process.platform !== "win32";
  const child = spawn(executable, [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--disable-background-networking",
    "--disable-default-apps",
    "--disable-extensions",
    "--mute-audio",
    "--no-first-run",
    "--remote-allow-origins=*",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    ...extraArgs,
    "about:blank"
  ], {
    detached,
    stdio: ["ignore", "ignore", "pipe"]
  });

  try {
    const websocketUrl = await withTimeout(new Promise((resolve, reject) => {
      let buffer = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        buffer += chunk;
        const match = buffer.match(/DevTools listening on (ws:\/\/[^\s]+)/u);
        if (match) resolve(match[1]);
        if (buffer.length > 128_000) buffer = buffer.slice(-64_000);
      });
      child.once("error", reject);
      child.once("exit", (code, signal) => reject(new Error(`Chromium exited before DevTools started: ${code ?? signal}.`)));
    }), timeoutMs, "Chromium did not expose a DevTools endpoint.");
    return { child, detached, websocketUrl };
  } catch (error) {
    try {
      if (detached) process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {}
    throw error;
  }
}

async function stopBrowser(browser) {
  if (!browser?.child || browser.child.exitCode !== null) return;
  const signal = (name) => {
    try {
      if (browser.detached) process.kill(-browser.child.pid, name);
      else browser.child.kill(name);
    } catch {}
  };
  signal("SIGTERM");
  await Promise.race([once(browser.child, "exit"), delay(1500)]).catch(() => {});
  if (browser.child.exitCode === null) {
    signal("SIGKILL");
    await Promise.race([once(browser.child, "exit"), delay(1500)]).catch(() => {});
  }
}

async function connectCdp(url, timeoutMs) {
  const socket = new WebSocket(url);
  await withTimeout(new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("Failed to connect to Chromium DevTools.")), { once: true });
  }), timeoutMs, "Timed out while connecting to Chromium DevTools.");

  let sequence = 0;
  const pending = new Map();
  const listeners = new Set();
  socket.addEventListener("message", (event) => {
    const text = typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8");
    const message = JSON.parse(text);
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(`${request.method}: ${message.error.message}`));
      else request.resolve(message.result ?? {});
      return;
    }
    for (const listener of listeners) listener(message);
  });

  const send = (method, params = {}, sessionId = undefined) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { method, resolve, reject });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

  const waitFor = (method, sessionId, predicate = () => true, waitMs = timeoutMs) => new Promise((resolve, reject) => {
    const listener = (message) => {
      if (message.method !== method) return;
      if (sessionId && message.sessionId !== sessionId) return;
      if (!predicate(message.params ?? {})) return;
      clearTimeout(timer);
      listeners.delete(listener);
      resolve(message.params ?? {});
    };
    const timer = setTimeout(() => {
      listeners.delete(listener);
      reject(new Error(`Timed out waiting for ${method}.`));
    }, waitMs);
    listeners.add(listener);
  });

  return {
    socket,
    send,
    waitFor,
    on(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    close() {
      for (const request of pending.values()) request.reject(new Error("DevTools connection closed."));
      pending.clear();
      socket.close();
    }
  };
}

function expressionForSelector(selector, body) {
  return `(() => { const element = document.querySelector(${JSON.stringify(selector)}); ${body} })()`;
}

async function run() {
  const spec = readSpec();
  const url = process.env.METIS_BROWSER_URL || spec.url;
  if (!url) throw new Error("METIS_BROWSER_URL is required.");
  const width = Number(process.env.METIS_BROWSER_VIEWPORT_WIDTH || spec.viewport?.width || 1280);
  const height = Number(process.env.METIS_BROWSER_VIEWPORT_HEIGHT || spec.viewport?.height || 720);
  const timeoutMs = Number(spec.timeoutMs || DEFAULT_TIMEOUT);
  const profile = mkdtempSync(path.join(os.tmpdir(), "metis-chromium-"));
  const browserArgs = Array.isArray(spec.browserArgs)
    ? spec.browserArgs.map((item) => String(item)).filter((item) => item && !item.includes("\0"))
    : [];
  const browser = await startBrowser(browserExecutable(spec), profile, timeoutMs, browserArgs);
  let cdp;
  let targetId;
  let sessionId;
  const consoleErrors = [];
  const networkFailures = [];
  const actionResults = [];
  const assertionResults = [];

  try {
    cdp = await connectCdp(browser.websocketUrl, timeoutMs);
    ({ targetId } = await cdp.send("Target.createTarget", { url: "about:blank" }));
    ({ sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true }));

    await Promise.all([
      cdp.send("Page.enable", {}, sessionId),
      cdp.send("Runtime.enable", {}, sessionId),
      cdp.send("Network.enable", {}, sessionId),
      cdp.send("Log.enable", {}, sessionId),
      cdp.send("Emulation.setDeviceMetricsOverride", {
        width: Math.max(1, Math.floor(width)),
        height: Math.max(1, Math.floor(height)),
        deviceScaleFactor: Number(spec.deviceScaleFactor || 1),
        mobile: Boolean(spec.mobile)
      }, sessionId)
    ]);

    const removeListener = cdp.on((message) => {
      if (message.sessionId !== sessionId) return;
      if (message.method === "Runtime.consoleAPICalled" && message.params?.type === "error") {
        consoleErrors.push((message.params.args ?? []).map((item) => item.value ?? item.description ?? "").join(" "));
      }
      if (message.method === "Runtime.exceptionThrown") {
        consoleErrors.push(message.params?.exceptionDetails?.text ?? "Uncaught browser exception");
      }
      if (message.method === "Log.entryAdded" && message.params?.entry?.level === "error") {
        consoleErrors.push(message.params.entry.text);
      }
      if (message.method === "Network.loadingFailed") {
        networkFailures.push(`${message.params?.type ?? "resource"}: ${message.params?.errorText ?? "loading failed"}`);
      }
      if (message.method === "Network.responseReceived" && Number(message.params?.response?.status ?? 0) >= 400) {
        networkFailures.push(`${message.params.response.status} ${message.params.response.url}`);
      }
    });

    if (typeof spec.documentHtml === "string") {
      const { frameTree } = await cdp.send("Page.getFrameTree", {}, sessionId);
      await cdp.send("Page.setDocumentContent", {
        frameId: frameTree.frame.id,
        html: spec.documentHtml
      }, sessionId);
    } else {
      const navigation = await cdp.send("Page.navigate", { url }, sessionId);
      if (navigation.errorText) throw new Error(`Navigation failed: ${navigation.errorText}`);
    }

    const evaluate = async (expression) => {
      const response = await cdp.send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true
      }, sessionId);
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.text ?? "Browser evaluation failed.");
      return response.result?.value;
    };

    const waitForCondition = async (expression, waitMs = timeoutMs) => {
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline) {
        if (await evaluate(expression)) return true;
        await delay(50);
      }
      return false;
    };

    const ready = await waitForCondition("document.readyState === 'complete'", timeoutMs);
    if (!ready) throw new Error("The browser page did not reach readyState=complete.");

    for (const action of spec.actions ?? []) {
      const type = String(action.type ?? "");
      let pass = true;
      let detail = "";
      if (type === "click") {
        const result = await evaluate(expressionForSelector(action.selector, "if (!element) return false; element.click(); return true;"));
        pass = Boolean(result);
        detail = action.selector;
      } else if (type === "fill") {
        const result = await evaluate(expressionForSelector(action.selector, `
          if (!element) return false;
          const value = ${JSON.stringify(String(action.value ?? ""))};
          const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value");
          if (descriptor?.set) descriptor.set.call(element, value); else element.value = value;
          element.dispatchEvent(new Event("input", { bubbles: true }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        `));
        pass = Boolean(result);
        detail = action.selector;
      } else if (type === "waitFor") {
        const state = action.state ?? "visible";
        const condition = state === "hidden"
          ? expressionForSelector(action.selector, "return !element || getComputedStyle(element).display === 'none' || getComputedStyle(element).visibility === 'hidden';")
          : expressionForSelector(action.selector, "if (!element) return false; const rect = element.getBoundingClientRect(); const style = getComputedStyle(element); return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';");
        pass = await waitForCondition(condition, Number(action.timeoutMs || timeoutMs));
        detail = `${action.selector}:${state}`;
      } else if (type === "wait") {
        await delay(Number(action.ms || 0));
        detail = `${Number(action.ms || 0)}ms`;
      } else if (type === "key") {
        const key = String(action.key ?? "Enter");
        await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key }, sessionId);
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key }, sessionId);
        detail = key;
      } else {
        pass = false;
        detail = `Unsupported action type: ${type}`;
      }
      actionResults.push({ type, pass, detail });
      if (!pass && action.required !== false) break;
      if (action.waitAfterMs) await delay(Number(action.waitAfterMs));
    }

    for (const assertion of spec.assertions ?? []) {
      const type = String(assertion.type ?? "");
      let pass = false;
      let actual;
      if (type === "visible") {
        pass = Boolean(await evaluate(expressionForSelector(assertion.selector, "if (!element) return false; const rect = element.getBoundingClientRect(); const style = getComputedStyle(element); return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';")));
      } else if (type === "text") {
        actual = await evaluate(expressionForSelector(assertion.selector, "return element ? element.textContent.trim() : null;"));
        pass = assertion.equals !== undefined ? actual === String(assertion.equals) : String(actual ?? "").includes(String(assertion.includes ?? ""));
      } else if (type === "attribute") {
        const attribute = String(assertion.attribute ?? "").trim();
        if (attribute) {
          actual = await evaluate(expressionForSelector(assertion.selector, `return element ? element.getAttribute(${JSON.stringify(attribute)}) : null;`));
          pass = assertion.equals !== undefined ? actual === String(assertion.equals) : actual !== null;
        }
      } else if (type === "count") {
        actual = await evaluate(`document.querySelectorAll(${JSON.stringify(assertion.selector)}).length`);
        pass = Number(actual) === Number(assertion.equals);
      } else if (type === "url") {
        actual = await evaluate("location.href");
        pass = assertion.equals !== undefined ? actual === String(assertion.equals) : String(actual).includes(String(assertion.includes ?? ""));
      } else if (type === "checked") {
        actual = await evaluate(expressionForSelector(assertion.selector, "return element ? Boolean(element.checked) : null;"));
        pass = actual === (assertion.equals ?? true);
      }
      assertionResults.push({ name: assertion.label ?? `${type}:${assertion.selector ?? "page"}`, type, pass, ...(actual !== undefined ? { actual } : {}) });
    }

    const screenshotRelative = spec.screenshot || `.metis/tmp/browser-${String(process.env.METIS_BROWSER_SCENARIO || "scenario").replace(/[^a-z0-9_-]+/gi, "-")}.png`;
    const screenshotAbsolute = path.resolve(screenshotRelative);
    mkdirSync(path.dirname(screenshotAbsolute), { recursive: true });
    const image = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false }, sessionId);
    writeFileSync(screenshotAbsolute, Buffer.from(image.data, "base64"));

    removeListener();
    const pass = actionResults.every((item) => item.pass) && assertionResults.every((item) => item.pass)
      && consoleErrors.length === 0 && networkFailures.length === 0;
    console.log(JSON.stringify({
      status: pass ? "passed" : "failed",
      actions: actionResults,
      assertions: assertionResults,
      screenshots: [path.relative(process.cwd(), screenshotAbsolute).replaceAll(path.sep, "/")],
      consoleErrors,
      networkFailures,
      source: typeof spec.documentHtml === "string" ? "inline-document" : url
    }));
  } finally {
    try { if (cdp && targetId) await cdp.send("Target.closeTarget", { targetId }); } catch {}
    try { cdp?.close(); } catch {}
    await stopBrowser(browser);
    rmSync(profile, { recursive: true, force: true });
  }
}

try {
  await run();
} catch (error) {
  process.exitCode = 1;
  console.log(JSON.stringify({
    status: "failed",
    actions: [],
    assertions: [],
    screenshots: [],
    consoleErrors: [error instanceof Error ? error.message : String(error)],
    networkFailures: []
  }));
}
