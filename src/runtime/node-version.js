export const MIN_NODE_VERSION = Object.freeze({ major: 22, minor: 16, patch: 0 });
export const MIN_NODE_VERSION_TEXT = "22.16.0";

function parseNodeVersion(value) {
  const match = String(value).match(/^(\d+)\.(\d+)\.(\d+)/u);
  return match ? match.slice(1).map(Number) : null;
}

export function isSupportedNodeVersion(value = process.versions.node) {
  const parsed = parseNodeVersion(value);
  if (!parsed) return false;
  const [major, minor, patch] = parsed;
  if (major !== MIN_NODE_VERSION.major) return major > MIN_NODE_VERSION.major;
  if (minor !== MIN_NODE_VERSION.minor) return minor > MIN_NODE_VERSION.minor;
  return patch >= MIN_NODE_VERSION.patch;
}

export function assertSupportedNodeVersion(value = process.versions.node) {
  if (isSupportedNodeVersion(value)) return value;
  const error = new Error(`Metis requires Node.js >= ${MIN_NODE_VERSION_TEXT}; detected ${value}.`);
  error.code = "ERR_METIS_NODE_VERSION";
  throw error;
}
