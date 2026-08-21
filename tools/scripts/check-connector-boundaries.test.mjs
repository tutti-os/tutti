import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "check-connector-boundaries.mjs"
);

test("accepts the intended Connector dependency direction", async () => {
  const workspaceRoot = await createFixtureWorkspace({
    "packages/connector/contracts/src/authorization.ts":
      "export const protocol = 'v1';",
    "packages/connector/daemon/core/application.go": "package core",
    "packages/connector/renderer/package.json": JSON.stringify({
      exports: {
        "./application": "./src/application/index.ts",
        "./ui": "./src/ui/index.ts"
      }
    }),
    "packages/connector/renderer/src/application/index.ts":
      "export type { Connector } from './contracts.ts';",
    "packages/connector/renderer/src/ui/index.ts":
      "import type { Connector } from '../application/index.ts'; export type { Connector };",
    "packages/connector/runtime/runtime.go":
      'package runtime\nimport _ "github.com/tutti-os/tutti/packages/connector/daemon/core"'
  });

  const result = runCheck(workspaceRoot);

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("rejects Renderer Application React imports and Runtime adapter dependencies", async () => {
  const workspaceRoot = await createFixtureWorkspace({
    "packages/connector/renderer/package.json": JSON.stringify({
      exports: { ".": "./src/index.ts" }
    }),
    "packages/connector/renderer/src/application/index.ts":
      "import { useState } from 'react'; export { useState };",
    "packages/connector/runtime/runtime.go":
      'package runtime\nimport _ "github.com/tutti-os/tutti/packages/connector/daemon/adapters/sqlite"'
  });

  const result = runCheck(workspaceRoot);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Application depends on UI or a host runtime/);
  assert.match(result.stderr, /Runtime depends on Daemon Application/);
  assert.match(result.stderr, /Renderer exposes a root barrel/);
});

async function createFixtureWorkspace(files) {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "tutti-connector-boundaries-")
  );
  for (const [filePath, content] of Object.entries(files)) {
    const absolutePath = join(workspaceRoot, filePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, "utf8");
  }
  return workspaceRoot;
}

function runCheck(workspaceRoot) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: { ...process.env, TUTTI_WORKSPACE_ROOT: workspaceRoot }
  });
}
