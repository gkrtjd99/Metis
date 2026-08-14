import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSupportedNodeVersion,
  isSupportedNodeVersion,
  MIN_NODE_VERSION_TEXT
} from "../src/runtime/node-version.js";

test("Node runtime guard accepts the minimum and newer versions", () => {
  assert.equal(isSupportedNodeVersion("22.16.0"), true);
  assert.equal(isSupportedNodeVersion("22.16.0-nightly20260814"), true);
  assert.equal(isSupportedNodeVersion("23.0.0"), true);
  assert.equal(assertSupportedNodeVersion("22.16.0"), "22.16.0");
});

test("Node runtime guard rejects older or invalid injected versions", () => {
  for (const version of ["22.15.9", "21.99.0", "not-a-version"]) {
    assert.equal(isSupportedNodeVersion(version), false);
    assert.throws(
      () => assertSupportedNodeVersion(version),
      (error) => error?.code === "ERR_METIS_NODE_VERSION" && error.message.includes(MIN_NODE_VERSION_TEXT)
    );
  }
});
