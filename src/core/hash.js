import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readSync, realpathSync } from "node:fs";
import path from "node:path";

export function hashFileContents(file) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = openSync(file, "r");
  try {
    while (true) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

function containsPath(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function resolveExistingPathWithin(root, candidate) {
  const rootReal = realpathSync.native(root);
  const candidateAbsolute = path.resolve(candidate);
  if (!existsSync(candidateAbsolute)) return { exists: false, path: candidateAbsolute, inside: containsPath(path.resolve(root), candidateAbsolute) };
  const candidateReal = realpathSync.native(candidateAbsolute);
  return { exists: true, path: candidateReal, inside: containsPath(rootReal, candidateReal) };
}
