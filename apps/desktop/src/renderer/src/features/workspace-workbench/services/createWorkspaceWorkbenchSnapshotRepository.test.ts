import assert from "node:assert/strict";
import test from "node:test";
import type {
  TuttidClient,
  WorkbenchSnapshot
} from "@tutti-os/client-tuttid-ts";
import { workbenchSnapshotSchemaVersion } from "@tutti-os/workbench-snapshot";
import {
  createAgentWindowIntent,
  createWorkspaceWindowIntent,
  encodeDesktopWindowIntent
} from "../../../../../shared/contracts/windowIntent.ts";
import { writeWorkspaceOnboardingAutoOpenedToSnapshot } from "./workspaceOnboarding.ts";
import { writeWorkspaceWallpaperIdToSnapshot } from "./workspaceWallpaper.ts";
import { createWorkspaceWorkbenchSnapshotRepository } from "./createWorkspaceWorkbenchSnapshotRepository.ts";

test("agent window composition keeps all workbench snapshot writes window-local", async () => {
  const calls: string[] = [];
  const repository = createWorkspaceWorkbenchSnapshotRepository({
    tuttidClient: createClient(calls),
    windowSearch: encodeDesktopWindowIntent(
      createAgentWindowIntent({ workspaceID: "workspace-1" })
    )
  });

  const loadedSnapshot = await repository.load("workspace-1");
  await repository.save("workspace-1", createSnapshot("host"));
  await repository.saveProductMetadata(
    "workspace-1",
    writeWorkspaceWallpaperIdToSnapshot(loadedSnapshot, "sky"),
    "wallpaper"
  );
  await repository.saveProductMetadata(
    "workspace-1",
    writeWorkspaceOnboardingAutoOpenedToSnapshot(loadedSnapshot),
    "onboarding"
  );

  assert.deepEqual(calls, ["get:workspace-1"]);
});

test("agent view fails closed when workspace id comes from startup fallback", async () => {
  const calls: string[] = [];
  const repository = createWorkspaceWorkbenchSnapshotRepository({
    tuttidClient: createClient(calls),
    windowSearch: "?view=agent"
  });

  await repository.load("workspace-fallback");
  await repository.save("workspace-fallback", createSnapshot("local"));

  assert.deepEqual(calls, ["get:workspace-fallback"]);
});

test("workspace window composition retains durable snapshot writes", async () => {
  const calls: string[] = [];
  const repository = createWorkspaceWorkbenchSnapshotRepository({
    tuttidClient: createClient(calls),
    windowSearch: encodeDesktopWindowIntent(
      createWorkspaceWindowIntent("workspace-1")
    )
  });

  await repository.load("workspace-1");
  await repository.save("workspace-1", createSnapshot("durable"));

  assert.deepEqual(calls, ["get:workspace-1", "put:workspace-1"]);
});

function createClient(calls: string[]): TuttidClient {
  return {
    async getWorkspaceWorkbench(workspaceID) {
      calls.push(`get:${workspaceID}`);
      return createSnapshot("loaded");
    },
    async putWorkspaceWorkbench(workspaceID, snapshot) {
      calls.push(`put:${workspaceID}`);
      return snapshot;
    }
  } as Partial<TuttidClient> as TuttidClient;
}

function createSnapshot(testRevision: string): WorkbenchSnapshot {
  return {
    activeNodeId: null,
    metadata: { testRevision },
    nodes: [],
    nodeStack: [],
    schemaVersion: workbenchSnapshotSchemaVersion
  };
}
