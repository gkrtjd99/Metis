import { assertSupportedNodeVersion } from "./runtime/node-version.js";

export { assertSupportedNodeVersion };

/** Public host-neutral project attachment facade. */
export async function init(options = {}) {
  assertSupportedNodeVersion();
  const { attachProject } = await import("./core/project-bootstrap.js");
  return attachProject(options);
}

export const attach = init;
