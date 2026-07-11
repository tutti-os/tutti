import assert from "node:assert/strict";
import test from "node:test";
import type {
  TuttidClient,
  WorkbenchSnapshot
} from "@tutti-os/client-tuttid-ts";
import { workbenchSnapshotSchemaVersion } from "@tutti-os/workbench-snapshot";
import {
  readWorkspaceWallpaperIdFromSnapshot,
  writeWorkspaceWallpaperIdToSnapshot
} from "../../workspaceWallpaper.ts";
import {
  hasWorkspaceOnboardingAutoOpened,
  writeWorkspaceOnboardingAutoOpenedToSnapshot
} from "../../workspaceOnboarding.ts";
import { createDesktopWorkspaceWorkbenchRepository } from "./desktopWorkspaceWorkbenchRepository.ts";

test("desktop workspace workbench repository caches loaded snapshots", async () => {
  const repository = createDesktopWorkspaceWorkbenchRepository(
    createTuttidClient({
      initialSnapshot: createSnapshot()
    })
  );
  let notificationCount = 0;
  repository.subscribe(() => {
    notificationCount += 1;
  });

  assert.equal(repository.hasLoaded("workspace-1"), false);
  const loadedSnapshot = await repository.load("workspace-1");

  assert.equal(repository.hasLoaded("workspace-1"), true);
  assert.equal(repository.readCached("workspace-1"), loadedSnapshot);
  assert.equal(notificationCount, 1);
});

test("desktop workspace workbench repository preserves wallpaper metadata on host saves", async () => {
  let savedSnapshot: WorkbenchSnapshot | null = null;
  const repository = createDesktopWorkspaceWorkbenchRepository(
    createTuttidClient({
      initialSnapshot: writeWorkspaceWallpaperIdToSnapshot(
        createSnapshot(),
        "sky"
      ),
      onSave(_workspaceID, snapshot) {
        savedSnapshot = snapshot;
      }
    })
  );

  await repository.load("workspace-1");
  await repository.save("workspace-1", createSnapshot());

  assert.equal(readWorkspaceWallpaperIdFromSnapshot(savedSnapshot), "sky");
});

test("desktop workspace workbench repository preserves onboarding metadata on host saves", async () => {
  let savedSnapshot: WorkbenchSnapshot | null = null;
  const repository = createDesktopWorkspaceWorkbenchRepository(
    createTuttidClient({
      initialSnapshot: writeWorkspaceOnboardingAutoOpenedToSnapshot(
        createSnapshot(),
        "2026-06-19T10:00:00.000Z"
      ),
      onSave(_workspaceID, snapshot) {
        savedSnapshot = snapshot;
      }
    })
  );

  await repository.load("workspace-1");
  await repository.save("workspace-1", createSnapshot());

  assert.equal(hasWorkspaceOnboardingAutoOpened(savedSnapshot), true);
});

test("desktop workspace workbench repository keeps daemon calls workspace-scoped and preserves product metadata", async () => {
  const calls: string[] = [];
  const persistedSnapshots: WorkbenchSnapshot[] = [];
  const authoritySnapshot = writeWorkspaceOnboardingAutoOpenedToSnapshot(
    writeWorkspaceWallpaperIdToSnapshot(createSnapshot(), "sky"),
    "2026-07-11T00:00:00.000Z"
  );
  const repository = createDesktopWorkspaceWorkbenchRepository(
    createTuttidClient({
      initialSnapshot: authoritySnapshot,
      onLoad(workspaceID) {
        calls.push(`get:${workspaceID}`);
      },
      onSave(workspaceID, snapshot) {
        calls.push(`put:${workspaceID}`);
        persistedSnapshots.push(snapshot);
      }
    })
  );
  const hostSnapshot: WorkbenchSnapshot = {
    ...createSnapshot(),
    metadata: { workbenchHostInitialized: true }
  };

  await repository.load("workspace-characterization");
  const saved = await repository.save(
    "workspace-characterization",
    hostSnapshot
  );

  assert.deepEqual(calls, [
    "get:workspace-characterization",
    "put:workspace-characterization"
  ]);
  const persistedSnapshot = persistedSnapshots[0];
  assert.ok(persistedSnapshot);
  assert.equal(readWorkspaceWallpaperIdFromSnapshot(persistedSnapshot), "sky");
  assert.equal(hasWorkspaceOnboardingAutoOpened(persistedSnapshot), true);
  assert.equal(persistedSnapshot.metadata?.workbenchHostInitialized, true);
  assert.equal(repository.readCached("workspace-characterization"), saved);
});

function createTuttidClient(input: {
  initialSnapshot: WorkbenchSnapshot;
  onLoad?: (workspaceID: string) => void;
  onSave?: (workspaceID: string, snapshot: WorkbenchSnapshot) => void;
}): TuttidClient {
  return {
    async getWorkspaceWorkbench(workspaceID) {
      input.onLoad?.(workspaceID);
      return input.initialSnapshot;
    },
    async putWorkspaceWorkbench(workspaceID, snapshot) {
      input.onSave?.(workspaceID, snapshot);
      return snapshot;
    }
  } as Partial<TuttidClient> as TuttidClient;
}

function createSnapshot(): WorkbenchSnapshot {
  return {
    schemaVersion: workbenchSnapshotSchemaVersion,
    nodes: [],
    nodeStack: [],
    activeNodeId: null
  };
}
