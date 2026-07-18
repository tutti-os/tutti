import type { WorkspaceDockRetentionService } from "../workspaceWorkbenchHostService.interface.ts";
import {
  readWorkspaceDockRetentionByEntryId,
  writeWorkspaceDockRetentionToSnapshot
} from "../workspaceDockRetention.ts";
import type { DesktopWorkspaceWorkbenchRepository } from "./adapters/desktopWorkspaceWorkbenchRepository.ts";

export function createWorkspaceDockRetentionController(
  repository: DesktopWorkspaceWorkbenchRepository
): WorkspaceDockRetentionService {
  const listeners = new Set<() => void>();
  const pendingByWorkspaceId = new Map<string, Map<string, boolean>>();
  const retainedByWorkspaceId = new Map<
    string,
    Readonly<Record<string, boolean>>
  >();
  const writeQueues = new Map<string, Promise<void>>();
  let revision = 0;

  const notify = () => {
    revision += 1;
    for (const listener of listeners) {
      listener();
    }
  };

  const resolveRetainedByEntryId = (workspaceId: string) => {
    const persisted = readWorkspaceDockRetentionByEntryId(
      repository.readCached(workspaceId)
    );
    const pending = pendingByWorkspaceId.get(workspaceId);
    return pending
      ? {
          ...persisted,
          ...Object.fromEntries(pending)
        }
      : persisted;
  };
  const refreshWorkspace = (workspaceId: string) => {
    const current = retainedByWorkspaceId.get(workspaceId);
    const next = resolveRetainedByEntryId(workspaceId);
    if (current && hasEqualRetention(current, next)) {
      return false;
    }
    retainedByWorkspaceId.set(workspaceId, next);
    return true;
  };
  const refreshKnownWorkspaces = () => {
    let changed = false;
    for (const workspaceId of retainedByWorkspaceId.keys()) {
      changed = refreshWorkspace(workspaceId) || changed;
    }
    if (changed) {
      notify();
    }
  };
  const unsubscribeRepository = repository.subscribe(refreshKnownWorkspaces);

  const clearPersistedChanges = (
    workspaceId: string,
    changes: ReadonlyMap<string, boolean>
  ) => {
    const pending = pendingByWorkspaceId.get(workspaceId);
    if (!pending) {
      return;
    }
    for (const [entryId, retained] of changes) {
      if (pending.get(entryId) === retained) {
        pending.delete(entryId);
      }
    }
    if (pending.size === 0) {
      pendingByWorkspaceId.delete(workspaceId);
    }
  };

  const persistPending = async (workspaceId: string) => {
    const pending = pendingByWorkspaceId.get(workspaceId);
    if (!pending?.size) {
      return;
    }
    const changes = new Map(pending);
    const cachedSnapshot = repository.readCached(workspaceId);
    const snapshot = cachedSnapshot
      ? cachedSnapshot
      : await repository.load(workspaceId);
    const retainedByEntryId = {
      ...readWorkspaceDockRetentionByEntryId(snapshot),
      ...Object.fromEntries(changes)
    };

    try {
      await repository.saveProductMetadata(
        workspaceId,
        writeWorkspaceDockRetentionToSnapshot(snapshot, retainedByEntryId),
        "dock"
      );
    } catch (error) {
      clearPersistedChanges(workspaceId, changes);
      if (refreshWorkspace(workspaceId)) {
        notify();
      }
      throw error;
    }

    clearPersistedChanges(workspaceId, changes);
    if (refreshWorkspace(workspaceId)) {
      notify();
    }
  };

  return {
    dispose() {
      unsubscribeRepository();
      listeners.clear();
      pendingByWorkspaceId.clear();
      retainedByWorkspaceId.clear();
      writeQueues.clear();
    },
    getRevision() {
      return revision;
    },
    readRetainedByEntryId(workspaceId) {
      if (!retainedByWorkspaceId.has(workspaceId)) {
        refreshWorkspace(workspaceId);
      }
      return retainedByWorkspaceId.get(workspaceId) ?? {};
    },
    setRetained(workspaceId, entryId, retained) {
      const pending = pendingByWorkspaceId.get(workspaceId) ?? new Map();
      pending.set(entryId, retained);
      pendingByWorkspaceId.set(workspaceId, pending);
      if (refreshWorkspace(workspaceId)) {
        notify();
      }

      const previousWrite = writeQueues.get(workspaceId) ?? Promise.resolve();
      const nextWrite = previousWrite
        .catch(noop)
        .then(() => persistPending(workspaceId));
      writeQueues.set(workspaceId, nextWrite);
      const clearQueue = () => {
        if (writeQueues.get(workspaceId) === nextWrite) {
          writeQueues.delete(workspaceId);
        }
      };
      void nextWrite.then(clearQueue, clearQueue);
      return nextWrite;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
}

function noop(): void {}

function hasEqualRetention(
  left: Readonly<Record<string, boolean>>,
  right: Readonly<Record<string, boolean>>
): boolean {
  const leftEntries = Object.entries(left);
  const rightKeys = Object.keys(right);
  return (
    leftEntries.length === rightKeys.length &&
    leftEntries.every(([entryId, retained]) => right[entryId] === retained)
  );
}
