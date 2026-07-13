import {
  migrateWorkbenchSnapshot,
  type WorkbenchSnapshot
} from "@tutti-os/workbench-snapshot";
import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import { preserveWorkspaceWallpaperSnapshotMetadata } from "../../workspaceWallpaper.ts";
import { preserveWorkspaceOnboardingSnapshotMetadata } from "../../workspaceOnboarding.ts";
import type { WorkbenchSnapshotRepositoryPort } from "../workbenchHostPorts.ts";

export interface DesktopWorkspaceWorkbenchRepository extends WorkbenchSnapshotRepositoryPort {
  hasLoaded(workspaceID: string): boolean;
  load(workspaceID: string): Promise<WorkbenchSnapshot>;
  readCached(workspaceID: string): WorkbenchSnapshot | null;
  save(
    workspaceID: string,
    snapshot: WorkbenchSnapshot
  ): Promise<WorkbenchSnapshot>;
  subscribe(listener: () => void): () => void;
}

export function createDesktopWorkspaceWorkbenchRepository(
  tuttidClient: TuttidClient
): DesktopWorkspaceWorkbenchRepository {
  const cachedSnapshots = new Map<string, WorkbenchSnapshot>();
  const loadedWorkspaceIDs = new Set<string>();
  const listeners = new Set<() => void>();

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

  return {
    hasLoaded(workspaceID) {
      return loadedWorkspaceIDs.has(workspaceID);
    },
    async load(workspaceID: string) {
      const snapshot = migrateWorkbenchSnapshot(
        await tuttidClient.getWorkspaceWorkbench(workspaceID)
      );
      writeCache(workspaceID, snapshot);
      return snapshot;
    },
    readCached(workspaceID) {
      return cachedSnapshots.get(workspaceID) ?? null;
    },
    async save(workspaceID: string, snapshot: WorkbenchSnapshot) {
      const snapshotWithMetadata = preserveWorkspaceWallpaperSnapshotMetadata(
        cachedSnapshots.get(workspaceID),
        preserveWorkspaceOnboardingSnapshotMetadata(
          cachedSnapshots.get(workspaceID),
          snapshot
        )
      );
      const savedSnapshot = migrateWorkbenchSnapshot(
        await tuttidClient.putWorkspaceWorkbench(
          workspaceID,
          snapshotWithMetadata
        )
      );
      writeCache(workspaceID, savedSnapshot);
      return savedSnapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
}
