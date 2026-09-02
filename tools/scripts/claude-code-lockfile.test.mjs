import assert from "node:assert/strict";
import test from "node:test";

import { pnpmPackageIntegrity } from "./claude-code-lockfile.mjs";

const integrity = "sha512-RxJ5fSPCGCxX5qO/b4IPXhldvtLHeYBAzTUJ4eOzO+g=";

test("reads pnpm single-quoted package keys", () => {
  const lockfile = `
packages:
  '@anthropic-ai/claude-agent-sdk@0.3.258':
    resolution: {integrity: ${integrity}}
`;
  assert.equal(
    pnpmPackageIntegrity(lockfile, "@anthropic-ai/claude-agent-sdk", "0.3.258"),
    integrity
  );
});

test("keeps compatibility with double-quoted package keys", () => {
  const lockfile = `
packages:
  "@anthropic-ai/claude-agent-sdk-darwin-arm64@0.3.258":
    resolution: {integrity: ${integrity}}
`;
  assert.equal(
    pnpmPackageIntegrity(
      lockfile,
      "@anthropic-ai/claude-agent-sdk-darwin-arm64",
      "0.3.258"
    ),
    integrity
  );
});

test("does not borrow integrity from another package version", () => {
  const lockfile = `
packages:
  '@anthropic-ai/claude-agent-sdk@0.3.220':
    resolution: {integrity: ${integrity}}
`;
  assert.equal(
    pnpmPackageIntegrity(lockfile, "@anthropic-ai/claude-agent-sdk", "0.3.258"),
    null
  );
});

test("does not borrow integrity from the next package mapping", () => {
  const lockfile = `
packages:
  '@anthropic-ai/claude-agent-sdk@0.3.258':
    resolution: {tarball: https://example.invalid/sdk.tgz}
  '@anthropic-ai/another-package@1.0.0':
    resolution: {integrity: ${integrity}}
`;
  assert.equal(
    pnpmPackageIntegrity(lockfile, "@anthropic-ai/claude-agent-sdk", "0.3.258"),
    null
  );
});
