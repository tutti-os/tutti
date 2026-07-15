import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const source = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "useWorkspaceWorkbenchShellRuntime.tsx"
  ),
  "utf8"
);

test("workbench app presenter registration is independent from App Center snapshots", () => {
  const hostReadyCallback = source.match(
    /const handleWorkbenchHostReady = useCallback\(([\s\S]*?)\n  \);/
  )?.[0];

  assert.ok(hostReadyCallback);
  assert.doesNotMatch(hostReadyCallback, /appCenterState/);
  assert.doesNotMatch(hostReadyCallback, /registerPresenter/);
  assert.match(
    source,
    /useEffect\(\(\) => \{\s*if \(!workbenchHost\)[\s\S]*?workspaceAppSurfaceHost\.registerPresenter\([\s\S]*?\[workbenchHost, state\.workspace\.id, workspaceAppSurfaceHost\]/
  );
});

test("workbench file preview presentation is registered through the surface host", () => {
  assert.match(
    source,
    /workspaceFilePreviewSurfaceHost\.registerPresenter\([\s\S]*?createWorkbenchWorkspaceFilePreviewPresenter\(\{ host: workbenchHost \}\)[\s\S]*?\[state\.workspace\.id, workbenchHost, workspaceFilePreviewSurfaceHost\]/
  );
  assert.doesNotMatch(source, /setCanvasFilePreviewLauncher/);
});
