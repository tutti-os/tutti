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

test("desktop workspace workbench repository serializes saves before reloading the same workspace", async () => {
  const calls: string[] = [];
  let persistedSnapshot = createSnapshot("initial");
  const pendingSaves: Array<{
    deferred: ReturnType<typeof createDeferred<WorkbenchSnapshot>>;
    snapshot: WorkbenchSnapshot;
  }> = [];
  const repository = createDesktopWorkspaceWorkbenchRepository({
    async getWorkspaceWorkbench(workspaceID) {
      calls.push(`get:${workspaceID}`);
      return persistedSnapshot;
    },
    async putWorkspaceWorkbench(workspaceID, snapshot) {
      calls.push(`put:${String(snapshot.metadata?.testRevision)}`);
      const deferred = createDeferred<WorkbenchSnapshot>();
      pendingSaves.push({ deferred, snapshot });
      persistedSnapshot = await deferred.promise;
      return persistedSnapshot;
    }
  } as Partial<TuttidClient> as TuttidClient);

  await repository.load("workspace-1");
  calls.length = 0;

  const firstSave = repository.save("workspace-1", createSnapshot("first"));
  const secondSave = repository.save("workspace-1", createSnapshot("second"));
  const reload = repository.load("workspace-1");
  await Promise.resolve();

  assert.deepEqual(calls, ["put:first"]);
  assert.equal(pendingSaves.length, 1);

  pendingSaves[0]?.deferred.resolve(pendingSaves[0].snapshot);
  await firstSave;
  await Promise.resolve();

  assert.deepEqual(calls, ["put:first", "put:second"]);
  assert.equal(pendingSaves.length, 2);

  pendingSaves[1]?.deferred.resolve(pendingSaves[1].snapshot);
  await secondSave;
  const loadedSnapshot = await reload;

  assert.deepEqual(calls, ["put:first", "put:second", "get:workspace-1"]);
  assert.equal(loadedSnapshot.metadata?.testRevision, "second");
  assert.equal(repository.readCached("workspace-1"), loadedSnapshot);
});

test("desktop workspace workbench repository orders final flush, immediate reopen, and the next save", async () => {
  const calls: string[] = [];
  let loadCount = 0;
  const reload = createDeferred<WorkbenchSnapshot>();
  const firstSave = createDeferred<WorkbenchSnapshot>();
  const secondSave = createDeferred<WorkbenchSnapshot>();
  const repository = createDesktopWorkspaceWorkbenchRepository({
    async getWorkspaceWorkbench(workspaceID) {
      loadCount += 1;
      calls.push(`get:${workspaceID}:${loadCount}`);
      return loadCount === 1 ? createSnapshot("initial") : reload.promise;
    },
    async putWorkspaceWorkbench(_workspaceID, snapshot) {
      const revision = String(snapshot.metadata?.testRevision);
      calls.push(`put:${revision}`);
      return revision === "first" ? firstSave.promise : secondSave.promise;
    }
  } as Partial<TuttidClient> as TuttidClient);

  await repository.load("workspace-1");
  calls.length = 0;
  const finalFlush = repository.save("workspace-1", createSnapshot("first"));
  const reopenedLoad = repository.load("workspace-1");
  const reopenedSave = repository.save("workspace-1", createSnapshot("second"));
  await Promise.resolve();

  assert.deepEqual(calls, ["put:first"]);
  firstSave.resolve(createSnapshot("first"));
  await finalFlush;
  await Promise.resolve();
  assert.deepEqual(calls, ["put:first", "get:workspace-1:2"]);

  reload.resolve(createSnapshot("first"));
  await reopenedLoad;
  await Promise.resolve();
  assert.deepEqual(calls, ["put:first", "get:workspace-1:2", "put:second"]);

  secondSave.resolve(createSnapshot("second"));
  const reopenedSavedSnapshot = await reopenedSave;
  assert.equal(reopenedSavedSnapshot.metadata?.testRevision, "second");
  assert.equal(
    repository.readCached("workspace-1")?.metadata?.testRevision,
    "second"
  );
});

test("desktop workspace workbench repository recovers its queue after a failed save", async () => {
  const calls: string[] = [];
  const repository = createDesktopWorkspaceWorkbenchRepository({
    async getWorkspaceWorkbench(workspaceID) {
      calls.push(`get:${workspaceID}`);
      return createSnapshot("loaded");
    },
    async putWorkspaceWorkbench(_workspaceID, snapshot) {
      const revision = String(snapshot.metadata?.testRevision);
      calls.push(`put:${revision}`);
      if (revision === "first") {
        throw new Error("save failed");
      }
      return snapshot;
    }
  } as Partial<TuttidClient> as TuttidClient);

  const failedSave = repository.save("workspace-1", createSnapshot("first"));
  const secondSave = repository.save("workspace-1", createSnapshot("second"));
  const load = repository.load("workspace-1");

  await assert.rejects(failedSave, /save failed/);
  assert.equal((await secondSave).metadata?.testRevision, "second");
  assert.equal((await load).metadata?.testRevision, "loaded");
  assert.deepEqual(calls, ["put:first", "put:second", "get:workspace-1"]);
});

test("desktop workspace workbench repository recovers its queue after a failed load", async () => {
  const calls: string[] = [];
  let loadCount = 0;
  let persistedSnapshot = createSnapshot("initial");
  const repository = createDesktopWorkspaceWorkbenchRepository({
    async getWorkspaceWorkbench(workspaceID) {
      loadCount += 1;
      calls.push(`get:${workspaceID}:${loadCount}`);
      if (loadCount === 1) {
        throw new Error("load failed");
      }
      return persistedSnapshot;
    },
    async putWorkspaceWorkbench(_workspaceID, snapshot) {
      calls.push(`put:${String(snapshot.metadata?.testRevision)}`);
      persistedSnapshot = snapshot;
      return snapshot;
    }
  } as Partial<TuttidClient> as TuttidClient);

  const failedLoad = repository.load("workspace-1");
  const save = repository.save("workspace-1", createSnapshot("recovered"));
  const recoveredLoad = repository.load("workspace-1");

  await assert.rejects(failedLoad, /load failed/);
  assert.equal((await save).metadata?.testRevision, "recovered");
  assert.equal((await recoveredLoad).metadata?.testRevision, "recovered");
  assert.deepEqual(calls, [
    "get:workspace-1:1",
    "put:recovered",
    "get:workspace-1:2"
  ]);
});

test("desktop workspace workbench repository does not block another workspace", async () => {
  const blockedSave = createDeferred<WorkbenchSnapshot>();
  const calls: string[] = [];
  const repository = createDesktopWorkspaceWorkbenchRepository({
    async getWorkspaceWorkbench(workspaceID) {
      calls.push(`get:${workspaceID}`);
      return createSnapshot(workspaceID);
    },
    async putWorkspaceWorkbench(workspaceID, snapshot) {
      calls.push(`put:${workspaceID}`);
      return workspaceID === "workspace-a" ? blockedSave.promise : snapshot;
    }
  } as Partial<TuttidClient> as TuttidClient);

  const saveA = repository.save("workspace-a", createSnapshot("a"));
  const saveB = repository.save("workspace-b", createSnapshot("b"));

  assert.equal((await saveB).metadata?.testRevision, "b");
  assert.deepEqual(calls, ["put:workspace-a", "put:workspace-b"]);
  blockedSave.resolve(createSnapshot("a"));
  await saveA;
});

test("window-local workbench repository never writes the durable workspace snapshot", async () => {
  let putCount = 0;
  let getCount = 0;
  const repository = createDesktopWorkspaceWorkbenchRepository(
    createTuttidClient({
      initialSnapshot: createSnapshot("durable"),
      onLoad() {
        getCount += 1;
      },
      onSave() {
        putCount += 1;
      }
    }),
    { persistence: "window-local" }
  );

  assert.equal(
    (await repository.load("workspace-1")).metadata?.testRevision,
    "durable"
  );
  const localSnapshot = await repository.save(
    "workspace-1",
    createSnapshot("standalone-local")
  );

  assert.equal(putCount, 0);
  assert.equal(
    (await repository.load("workspace-1")).metadata?.testRevision,
    "standalone-local"
  );
  assert.equal(getCount, 1);
  assert.equal(localSnapshot.metadata?.testRevision, "standalone-local");
  assert.equal(repository.readCached("workspace-1"), localSnapshot);
});

test("queued host saves cannot restore stale wallpaper metadata over a newer product write", async () => {
  const persistedSnapshots: WorkbenchSnapshot[] = [];
  const firstPut = createDeferred<WorkbenchSnapshot>();
  const initialSnapshot = writeWorkspaceWallpaperIdToSnapshot(
    createSnapshot("initial"),
    "sky"
  );
  const repository = createDesktopWorkspaceWorkbenchRepository({
    async getWorkspaceWorkbench() {
      return initialSnapshot;
    },
    async putWorkspaceWorkbench(_workspaceID, snapshot) {
      persistedSnapshots.push(snapshot);
      if (persistedSnapshots.length === 1) {
        return firstPut.promise;
      }
      return snapshot;
    }
  } as Partial<TuttidClient> as TuttidClient);

  await repository.load("workspace-1");
  const blockingHostSave = repository.save(
    "workspace-1",
    createSnapshot("blocking-host", "current-wallpaper-node")
  );
  await Promise.resolve();
  const wallpaperSave = repository.saveProductMetadata(
    "workspace-1",
    writeWorkspaceWallpaperIdToSnapshot(initialSnapshot, "ocean"),
    "wallpaper"
  );
  const staleHostSave = repository.save(
    "workspace-1",
    writeWorkspaceWallpaperIdToSnapshot(createSnapshot("host"), "sky")
  );
  const firstPersistedSnapshot = persistedSnapshots[0];
  assert.ok(firstPersistedSnapshot);
  firstPut.resolve(firstPersistedSnapshot);
  await Promise.all([blockingHostSave, wallpaperSave, staleHostSave]);

  assert.equal(
    readWorkspaceWallpaperIdFromSnapshot(persistedSnapshots[1]),
    "ocean"
  );
  assert.equal(persistedSnapshots[1]?.metadata?.testRevision, "blocking-host");
  assert.deepEqual(
    persistedSnapshots[1]?.nodes.map((node) => node.id),
    ["current-wallpaper-node"]
  );
  assert.equal(
    readWorkspaceWallpaperIdFromSnapshot(persistedSnapshots[2]),
    "ocean"
  );
});

test("queued host saves cannot restore stale onboarding metadata over a newer product write", async () => {
  const persistedSnapshots: WorkbenchSnapshot[] = [];
  const firstPut = createDeferred<WorkbenchSnapshot>();
  const initialSnapshot = writeWorkspaceOnboardingAutoOpenedToSnapshot(
    createSnapshot("initial"),
    "2026-01-01T00:00:00.000Z"
  );
  const updatedSnapshot = writeWorkspaceOnboardingAutoOpenedToSnapshot(
    initialSnapshot,
    "2026-07-15T00:00:00.000Z"
  );
  const repository = createDesktopWorkspaceWorkbenchRepository({
    async getWorkspaceWorkbench() {
      return initialSnapshot;
    },
    async putWorkspaceWorkbench(_workspaceID, snapshot) {
      persistedSnapshots.push(snapshot);
      if (persistedSnapshots.length === 1) {
        return firstPut.promise;
      }
      return snapshot;
    }
  } as Partial<TuttidClient> as TuttidClient);

  await repository.load("workspace-1");
  const blockingHostSave = repository.save(
    "workspace-1",
    createSnapshot("blocking-host", "current-onboarding-node")
  );
  await Promise.resolve();
  const onboardingSave = repository.saveProductMetadata(
    "workspace-1",
    updatedSnapshot,
    "onboarding"
  );
  const staleHostSave = repository.save("workspace-1", initialSnapshot);
  const firstPersistedSnapshot = persistedSnapshots[0];
  assert.ok(firstPersistedSnapshot);
  firstPut.resolve(firstPersistedSnapshot);
  await Promise.all([blockingHostSave, onboardingSave, staleHostSave]);

  assert.deepEqual(
    persistedSnapshots[1]?.metadata?.workspaceOnboarding,
    updatedSnapshot.metadata?.workspaceOnboarding
  );
  assert.equal(persistedSnapshots[1]?.metadata?.testRevision, "blocking-host");
  assert.deepEqual(
    persistedSnapshots[1]?.nodes.map((node) => node.id),
    ["current-onboarding-node"]
  );
  assert.deepEqual(
    persistedSnapshots[2]?.metadata?.workspaceOnboarding,
    updatedSnapshot.metadata?.workspaceOnboarding
  );
});

test("host saves remove stale product metadata when the current cache has none", async () => {
  const persistedSnapshots: WorkbenchSnapshot[] = [];
  const repository = createDesktopWorkspaceWorkbenchRepository(
    createTuttidClient({
      initialSnapshot: createSnapshot("initial"),
      onSave(_workspaceID, snapshot) {
        persistedSnapshots.push(snapshot);
      }
    })
  );

  await repository.load("workspace-1");
  await repository.save(
    "workspace-1",
    writeWorkspaceWallpaperIdToSnapshot(createSnapshot("stale"), "sky")
  );

  const persistedSnapshot = persistedSnapshots[0];
  assert.ok(persistedSnapshot);
  assert.equal(
    readWorkspaceWallpaperIdFromSnapshot(persistedSnapshot),
    "tutti"
  );
  assert.equal(persistedSnapshot.metadata?.workspaceWallpaper, undefined);
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

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function createSnapshot(
  testRevision?: string,
  nodeID?: string
): WorkbenchSnapshot {
  return {
    ...(testRevision ? { metadata: { testRevision } } : {}),
    schemaVersion: workbenchSnapshotSchemaVersion,
    nodes: nodeID
      ? [
          {
            frame: { height: 400, width: 600, x: 20, y: 20 },
            id: nodeID,
            kind: "test",
            title: nodeID
          }
        ]
      : [],
    nodeStack: nodeID ? [nodeID] : [],
    activeNodeId: nodeID ?? null
  };
}
