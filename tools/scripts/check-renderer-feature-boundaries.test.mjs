import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const scriptPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "check-renderer-feature-boundaries.mjs"
);
const rendererRoot = "apps/desktop/src/renderer/src";

test("allows a feature to import its own services/internal implementation", async () => {
  const workspaceRoot = await createFixtureWorkspace({
    "features/workspace-launcher/services/internal/secret.ts":
      "export const secret = 1;\n",
    "features/workspace-launcher/ui/WorkspaceLauncher.tsx":
      'import { secret } from "../services/internal/secret";\nconsole.log(secret);\n'
  });

  const result = runBoundaryCheck(workspaceRoot);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /renderer feature boundary check passed/);
});

test("rejects workspace workbench UI imports of its services/internal implementation", async () => {
  const workspaceRoot = await createFixtureWorkspace({
    "features/workspace-workbench/services/internal/workspaceLaunchpadModel.ts":
      "export const model = 1;\n",
    "features/workspace-workbench/ui/WorkspaceLaunchpadOverlay.tsx":
      'import { model } from "../services/internal/workspaceLaunchpadModel";\nconsole.log(model);\n'
  });

  const result = runBoundaryCheck(workspaceRoot);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /workspace-workbench-ui-internal-import/);
  assert.match(result.stderr, /services\/internal/);
});

test("allows workspace workbench UI imports of public services", async () => {
  const workspaceRoot = await createFixtureWorkspace({
    "features/workspace-workbench/services/workspaceLaunchpadModel.ts":
      "export const model = 1;\n",
    "features/workspace-workbench/ui/WorkspaceLaunchpadOverlay.tsx":
      'import { model } from "../services/workspaceLaunchpadModel";\nconsole.log(model);\n'
  });

  const result = runBoundaryCheck(workspaceRoot);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /renderer feature boundary check passed/);
});

test("rejects cross-feature imports of services/internal implementation", async () => {
  const workspaceRoot = await createFixtureWorkspace({
    "features/workspace-launcher/services/internal/secret.ts":
      "export const secret = 1;\n",
    "features/workspace-overview/ui/WorkspaceOverview.tsx":
      'import { secret } from "@renderer/features/workspace-launcher/services/internal/secret";\nconsole.log(secret);\n'
  });

  const result = runBoundaryCheck(workspaceRoot);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /feature-internal-import/);
  assert.match(result.stderr, /workspace-launcher\/services\/internal/);
});

test("rejects app-level relative imports of feature services/internal implementation", async () => {
  const workspaceRoot = await createFixtureWorkspace({
    "features/workspace-launcher/services/internal/secret.ts":
      "export const secret = 1;\n",
    "app/windows/dashboard/DashboardWindow.tsx":
      'import { secret } from "../../../features/workspace-launcher/services/internal/secret";\nconsole.log(secret);\n'
  });

  const result = runBoundaryCheck(workspaceRoot);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /feature-internal-import/);
});

test("allows window containers to read the preload API composition root", async () => {
  const workspaceRoot = await createFixtureWorkspace({
    "app/windows/dashboard/createDashboardWindowContainer.ts":
      "registerDashboardServices(registry, window.tutti);\n"
  });

  const result = runBoundaryCheck(workspaceRoot);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /renderer feature boundary check passed/);
});

test("rejects feature UI direct access to the preload API", async () => {
  const workspaceRoot = await createFixtureWorkspace({
    "features/app-update/ui/AppUpdateStatus.tsx":
      "void window.tutti.update.getState();\n"
  });

  const result = runBoundaryCheck(workspaceRoot);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /renderer-window-tutti-access/);
});

test("rejects feature service direct access to the preload API", async () => {
  const workspaceRoot = await createFixtureWorkspace({
    "features/workspace-launcher/services/internal/workspaceLauncherService.ts":
      'void window.tutti.host.workspace.showWorkspace("workspace");\n'
  });

  const result = runBoundaryCheck(workspaceRoot);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /renderer-window-tutti-access/);
});

test("rejects private Maps in workspace launch coordinators", async () => {
  const workspaceRoot = await createFixtureWorkspace({
    "features/workspace-workbench/services/workspaceExampleLaunchCoordinator.ts":
      "const handlersByWorkspaceId = new Map<string, () => void>();\n"
  });

  const result = runBoundaryCheck(workspaceRoot);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /workspace-launch-coordinator-private-map/);
  assert.match(result.stderr, /WorkspaceScopedRegistrationRegistry/);
});

test("rejects private Maps in the workspace message center coordinator", async () => {
  const workspaceRoot = await createFixtureWorkspace({
    "features/workspace-workbench/services/workspaceMessageCenterCoordinator.ts":
      "const handlersByWorkspaceId = new Map<string, () => void>();\n"
  });

  const result = runBoundaryCheck(workspaceRoot);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /workspace-launch-coordinator-private-map/);
});

test("allows workspace launch coordinators to use the shared registration registry", async () => {
  const workspaceRoot = await createFixtureWorkspace({
    "features/workspace-workbench/services/internal/workspaceScopedRegistrationRegistry.ts":
      "export class WorkspaceScopedRegistrationRegistry<T> {}\n",
    "features/workspace-workbench/services/workspaceExampleLaunchCoordinator.ts":
      'import { WorkspaceScopedRegistrationRegistry } from "./internal/workspaceScopedRegistrationRegistry";\nconst handlers = new WorkspaceScopedRegistrationRegistry<() => void>();\n'
  });

  const result = runBoundaryCheck(workspaceRoot);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /renderer feature boundary check passed/);
});

test("allows non-launch coordinator Maps outside the Shell registration rule", async () => {
  const workspaceRoot = await createFixtureWorkspace({
    "features/workspace-workbench/services/workspaceAgentGuiOpenSessionCoordinator.ts":
      "const refCountsByWorkspaceId = new Map<string, number>();\n"
  });

  const result = runBoundaryCheck(workspaceRoot);

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

async function createFixtureWorkspace(files) {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "tutti-renderer-boundaries-")
  );

  for (const [path, content] of Object.entries(files)) {
    const absolutePath = join(workspaceRoot, rendererRoot, path);
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
      TUTTI_WORKSPACE_ROOT: workspaceRoot,
      TUTTI_RENDERER_ROOT: rendererRoot
    }
  });
}
