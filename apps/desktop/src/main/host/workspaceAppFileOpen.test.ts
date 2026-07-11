import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveWorkspaceAppFolderPath } from "./workspaceAppFolderPaths.ts";
import { resolveWorkspaceAppOpenFileAbsolutePath } from "./workspaceAppFileOpen.ts";

test("explicit package location overrides a legacy absolute path", async () => {
  const stateRootDir = await mkdtemp(join(tmpdir(), "tutti-app-file-open-"));
  try {
    const packageRoot = resolveWorkspaceAppFolderPath(stateRootDir, {
      appId: "slides",
      folderKind: "package",
      version: "1.2.3",
      workspaceId: "workspace-1"
    });
    await mkdir(packageRoot, { recursive: true });
    const expected = join(packageRoot, "assets", "deck.json");
    await mkdir(join(packageRoot, "assets"), { recursive: true });
    await writeFile(expected, "{}", "utf8");

    const resolved = await resolveWorkspaceAppOpenFileAbsolutePath(
      stateRootDir,
      {
        appId: "slides",
        workspaceId: "workspace-1",
        request: {
          path: "/legacy/absolute/deck.json",
          location: {
            type: "app-package-relative",
            path: "assets/deck.json"
          },
          packageVersion: "1.2.3"
        }
      }
    );

    assert.equal(resolved, expected);
  } finally {
    await rm(stateRootDir, { recursive: true, force: true });
  }
});

test("explicit relative locations reject traversal", async () => {
  await assert.rejects(
    resolveWorkspaceAppOpenFileAbsolutePath("/tmp/tutti-state", {
      appId: "slides",
      workspaceId: "workspace-1",
      request: {
        path: "fallback.txt",
        location: {
          type: "app-data-relative",
          path: "../escape.txt"
        }
      }
    }),
    /path is invalid/
  );
});
