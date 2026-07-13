import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "check-agent-activity-runtime-boundaries.mjs"
);

test("allows an unrelated external-store subscription beside a session engine read", async () => {
  const workspaceRoot = await createFixtureWorkspace({
    "apps/desktop/src/renderer/src/features/workspace-workbench/AgentSurface.tsx": `
      import { useSyncExternalStore } from "react";

      export function AgentSurface({ activityService, agentsService, workspaceId }) {
        const engine = activityService.getSessionEngine(workspaceId);
        const agents = useSyncExternalStore(
          agentsService.subscribe,
          agentsService.getSnapshot,
          agentsService.getSnapshot
        );
        return <span>{engine.workspaceId}:{agents.length}</span>;
      }
    `
  });

  const result = runBoundaryCheck(workspaceRoot);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /agent activity runtime boundary check passed/i);
});

test("rejects a direct session-engine external-store subscription", async () => {
  const workspaceRoot = await createFixtureWorkspace({
    "apps/desktop/src/renderer/src/features/workspace-workbench/AgentSurface.tsx": `
      import { useSyncExternalStore } from "react";

      export function AgentSurface({ activityService, workspaceId }) {
        const engine = activityService.getSessionEngine(workspaceId);
        const snapshot = useSyncExternalStore(
          engine.subscribe,
          engine.getSnapshot,
          engine.getSnapshot
        );
        return <span>{snapshot.sessions.length}</span>;
      }
    `
  });

  const result = runBoundaryCheck(workspaceRoot);

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /direct AgentSessionEngine useSyncExternalStore subscription/
  );
});

test("rejects aliased callbacks derived from a session engine", async () => {
  const workspaceRoot = await createFixtureWorkspace({
    "apps/desktop/src/renderer/src/features/workspace-workbench/AgentSurface.tsx": `
      import { useSyncExternalStore } from "react";

      export function AgentSurface({ activityService, workspaceId }) {
        const engine = activityService.getSessionEngine(workspaceId);
        const subscribe = engine.subscribe;
        const getSnapshot = () => engine.getSnapshot();
        const snapshot = useSyncExternalStore(
          subscribe,
          getSnapshot,
          getSnapshot
        );
        return <span>{snapshot.sessions.length}</span>;
      }
    `
  });

  const result = runBoundaryCheck(workspaceRoot);

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /direct AgentSessionEngine useSyncExternalStore subscription/
  );
});

async function createFixtureWorkspace(files) {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "tutti-agent-activity-boundaries-")
  );
  await mkdir(join(workspaceRoot, "packages/agent/gui"), { recursive: true });

  for (const [path, content] of Object.entries(files)) {
    const absolutePath = join(workspaceRoot, path);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, "utf8");
  }

  return workspaceRoot;
}

function runBoundaryCheck(workspaceRoot) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      TUTTI_WORKSPACE_ROOT: workspaceRoot
    }
  });
}
