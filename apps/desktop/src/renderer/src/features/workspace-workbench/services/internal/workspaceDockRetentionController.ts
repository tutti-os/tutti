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
  const writeQueues = new Map<string, Promise<void>>();
  let revision = 0;

  const notify = () => {
    revision += 1;
    for (const listener of listeners) {
      listener();
    }
  };
  const unsubscribeRepository = repository.subscribe(notify);

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
      notify();
      throw error;
    }

    clearPersistedChanges(workspaceId, changes);
  };

  return {
    dispose() {
      unsubscribeRepository();
      listeners.clear();
    },
    getRevision() {
      return revision;
    },
    readRetainedByEntryId(workspaceId) {
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
    },
    setRetained(workspaceId, entryId, retained) {
      const pending = pendingByWorkspaceId.get(workspaceId) ?? new Map();
      pending.set(entryId, retained);
      pendingByWorkspaceId.set(workspaceId, pending);
      notify();

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
