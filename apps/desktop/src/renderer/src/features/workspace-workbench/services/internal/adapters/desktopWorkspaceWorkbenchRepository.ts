import {
  migrateWorkbenchSnapshot,
  type WorkbenchSnapshot
} from "@tutti-os/workbench-snapshot";
import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import { replaceWorkspaceWallpaperSnapshotMetadata } from "../../workspaceWallpaper.ts";
import { replaceWorkspaceOnboardingSnapshotMetadata } from "../../workspaceOnboarding.ts";
import type { WorkbenchSnapshotRepositoryPort } from "../workbenchHostPorts.ts";

export type DesktopWorkspaceWorkbenchProductMetadataOwner =
  | "onboarding"
  | "wallpaper";

export interface DesktopWorkspaceWorkbenchRepositoryOptions {
  persistence: "durable" | "window-local";
}

export interface DesktopWorkspaceWorkbenchRepository extends WorkbenchSnapshotRepositoryPort {
  hasLoaded(workspaceID: string): boolean;
  load(workspaceID: string): Promise<WorkbenchSnapshot>;
  readCached(workspaceID: string): WorkbenchSnapshot | null;
  save(
    workspaceID: string,
    snapshot: WorkbenchSnapshot
  ): Promise<WorkbenchSnapshot>;
  saveProductMetadata(
    workspaceID: string,
    snapshot: WorkbenchSnapshot,
    owner: DesktopWorkspaceWorkbenchProductMetadataOwner
  ): Promise<WorkbenchSnapshot>;
  subscribe(listener: () => void): () => void;
}

export function createDesktopWorkspaceWorkbenchRepository(
  tuttidClient: TuttidClient,
  options: DesktopWorkspaceWorkbenchRepositoryOptions = {
    persistence: "durable"
  }
): DesktopWorkspaceWorkbenchRepository {
  const cachedSnapshots = new Map<string, WorkbenchSnapshot>();
  const loadedWorkspaceIDs = new Set<string>();
  const listeners = new Set<() => void>();
  const pendingWorkspaceOperations = new Map<string, Promise<void>>();

  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };
  const writeCache = (workspaceID: string, snapshot: WorkbenchSnapshot) => {
    cachedSnapshots.set(workspaceID, snapshot);
    loadedWorkspaceIDs.add(workspaceID);
    notify();
  };

  const enqueueWorkspaceOperation = <T>(
    workspaceID: string,
    operation: () => Promise<T>
  ): Promise<T> => {
    const previousOperation = pendingWorkspaceOperations.get(workspaceID);
    const nextOperation = (previousOperation ?? Promise.resolve()).then(
      operation
    );
    const settledOperation = nextOperation.then(noop, noop);
    pendingWorkspaceOperations.set(workspaceID, settledOperation);
    void settledOperation.finally(() => {
      if (pendingWorkspaceOperations.get(workspaceID) === settledOperation) {
        pendingWorkspaceOperations.delete(workspaceID);
      }
    });
    return nextOperation;
  };

  const save = (
    workspaceID: string,
    snapshot: WorkbenchSnapshot,
    productMetadataOwner: DesktopWorkspaceWorkbenchProductMetadataOwner | null
  ): Promise<WorkbenchSnapshot> =>
    enqueueWorkspaceOperation(workspaceID, async () => {
      const cachedSnapshot = cachedSnapshots.get(workspaceID);
      const snapshotWithMetadata = mergeProductMetadata({
        cachedSnapshot,
        owner: productMetadataOwner,
        snapshot
      });
      if (options.persistence === "window-local") {
        const localSnapshot = migrateWorkbenchSnapshot(snapshotWithMetadata);
        writeCache(workspaceID, localSnapshot);
        return localSnapshot;
      }
      const savedSnapshot = migrateWorkbenchSnapshot(
        await tuttidClient.putWorkspaceWorkbench(
          workspaceID,
          snapshotWithMetadata
        )
      );
      writeCache(workspaceID, savedSnapshot);
      return savedSnapshot;
    });

  return {
    hasLoaded(workspaceID) {
      return loadedWorkspaceIDs.has(workspaceID);
    },
    load(workspaceID: string) {
      return enqueueWorkspaceOperation(workspaceID, async () => {
        const cachedSnapshot = cachedSnapshots.get(workspaceID);
        if (options.persistence === "window-local" && cachedSnapshot) {
          return cachedSnapshot;
        }
        const snapshot = migrateWorkbenchSnapshot(
          await tuttidClient.getWorkspaceWorkbench(workspaceID)
        );
        writeCache(workspaceID, snapshot);
        return snapshot;
      });
    },
    readCached(workspaceID) {
      return cachedSnapshots.get(workspaceID) ?? null;
    },
    save(workspaceID: string, snapshot: WorkbenchSnapshot) {
      return save(workspaceID, snapshot, null);
    },
    saveProductMetadata(workspaceID, snapshot, owner) {
      return save(workspaceID, snapshot, owner);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
}

function mergeProductMetadata(input: {
  cachedSnapshot: WorkbenchSnapshot | undefined;
  owner: DesktopWorkspaceWorkbenchProductMetadataOwner | null;
  snapshot: WorkbenchSnapshot;
}): WorkbenchSnapshot {
  if (input.owner === "onboarding") {
    return replaceWorkspaceOnboardingSnapshotMetadata(
      input.snapshot,
      input.cachedSnapshot ?? input.snapshot
    );
  }
  if (input.owner === "wallpaper") {
    return replaceWorkspaceWallpaperSnapshotMetadata(
      input.snapshot,
      input.cachedSnapshot ?? input.snapshot
    );
  }

  const snapshotWithOnboarding = replaceWorkspaceOnboardingSnapshotMetadata(
    input.cachedSnapshot,
    input.snapshot
  );
  return replaceWorkspaceWallpaperSnapshotMetadata(
    input.cachedSnapshot,
    snapshotWithOnboarding
  );
}

function noop(): void {}
