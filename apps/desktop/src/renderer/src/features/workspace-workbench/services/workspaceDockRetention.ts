import type { WorkbenchSnapshot } from "@tutti-os/workbench-snapshot";

const workspaceDockMetadataKey = "workspaceDock";
const workspaceDockMetadataSchemaVersion = 1;

interface WorkspaceDockSnapshotMetadata {
  retainedByEntryId: Record<string, boolean>;
  schemaVersion: typeof workspaceDockMetadataSchemaVersion;
}

export function readWorkspaceDockRetentionByEntryId(
  snapshot: WorkbenchSnapshot | null | undefined
): Readonly<Record<string, boolean>> {
  const metadata = snapshot?.metadata?.[workspaceDockMetadataKey];
  if (!isRecord(metadata)) {
    return {};
  }
  if (metadata.schemaVersion !== workspaceDockMetadataSchemaVersion) {
    return {};
  }
  if (!isRecord(metadata.retainedByEntryId)) {
    return {};
  }

  const retainedByEntryId: Record<string, boolean> = {};
  for (const [entryId, retained] of Object.entries(
    metadata.retainedByEntryId
  )) {
    if (entryId.length > 0 && typeof retained === "boolean") {
      retainedByEntryId[entryId] = retained;
    }
  }
  return retainedByEntryId;
}

export function writeWorkspaceDockRetentionToSnapshot(
  snapshot: WorkbenchSnapshot,
  retainedByEntryId: Readonly<Record<string, boolean>>
): WorkbenchSnapshot {
  return {
    ...snapshot,
    metadata: {
      ...(snapshot.metadata ?? {}),
      [workspaceDockMetadataKey]: {
        retainedByEntryId: { ...retainedByEntryId },
        schemaVersion: workspaceDockMetadataSchemaVersion
      } satisfies WorkspaceDockSnapshotMetadata
    }
  };
}

export function replaceWorkspaceDockSnapshotMetadata(
  authoritativeSnapshot: WorkbenchSnapshot | null | undefined,
  nextSnapshot: WorkbenchSnapshot
): WorkbenchSnapshot {
  const authoritativeMetadata =
    authoritativeSnapshot?.metadata?.[workspaceDockMetadataKey];
  const {
    [workspaceDockMetadataKey]: _discardedWorkspaceDockMetadata,
    ...nextMetadata
  } = nextSnapshot.metadata ?? {};

  return {
    ...nextSnapshot,
    metadata:
      authoritativeMetadata === undefined
        ? nextMetadata
        : {
            ...nextMetadata,
            [workspaceDockMetadataKey]: authoritativeMetadata
          }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
