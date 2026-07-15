import type { WorkbenchSnapshot } from "@tutti-os/workbench-snapshot";

export const workspaceOnboardingAppId = "tutti-onboarding";

const workspaceOnboardingMetadataKey = "workspaceOnboarding";
const workspaceOnboardingMetadataSchemaVersion = 1;

interface WorkspaceOnboardingSnapshotMetadata {
  autoOpened: boolean;
  autoOpenedAt: string;
  schemaVersion: typeof workspaceOnboardingMetadataSchemaVersion;
}

export function hasWorkspaceOnboardingAutoOpened(
  snapshot: WorkbenchSnapshot | null | undefined
): boolean {
  const metadata = readWorkspaceOnboardingMetadata(snapshot);
  return metadata?.autoOpened === true;
}

export function writeWorkspaceOnboardingAutoOpenedToSnapshot(
  snapshot: WorkbenchSnapshot,
  autoOpenedAt = new Date().toISOString()
): WorkbenchSnapshot {
  return {
    ...snapshot,
    metadata: {
      ...snapshot.metadata,
      [workspaceOnboardingMetadataKey]: {
        autoOpened: true,
        autoOpenedAt,
        schemaVersion: workspaceOnboardingMetadataSchemaVersion
      } satisfies WorkspaceOnboardingSnapshotMetadata
    }
  };
}

export function preserveWorkspaceOnboardingSnapshotMetadata(
  previousSnapshot: WorkbenchSnapshot | null | undefined,
  nextSnapshot: WorkbenchSnapshot
): WorkbenchSnapshot {
  if (nextSnapshot.metadata?.[workspaceOnboardingMetadataKey] !== undefined) {
    return nextSnapshot;
  }

  const onboardingMetadata =
    previousSnapshot?.metadata?.[workspaceOnboardingMetadataKey];
  if (onboardingMetadata === undefined) {
    return nextSnapshot;
  }

  return {
    ...nextSnapshot,
    metadata: {
      ...(nextSnapshot.metadata ?? {}),
      [workspaceOnboardingMetadataKey]: onboardingMetadata
    }
  };
}

export function replaceWorkspaceOnboardingSnapshotMetadata(
  authoritativeSnapshot: WorkbenchSnapshot | null | undefined,
  nextSnapshot: WorkbenchSnapshot
): WorkbenchSnapshot {
  const authoritativeMetadata =
    authoritativeSnapshot?.metadata?.[workspaceOnboardingMetadataKey];
  const {
    [workspaceOnboardingMetadataKey]: _discardedOnboardingMetadata,
    ...nextMetadata
  } = nextSnapshot.metadata ?? {};

  return {
    ...nextSnapshot,
    metadata:
      authoritativeMetadata === undefined
        ? nextMetadata
        : {
            ...nextMetadata,
            [workspaceOnboardingMetadataKey]: authoritativeMetadata
          }
  };
}

function readWorkspaceOnboardingMetadata(
  snapshot: WorkbenchSnapshot | null | undefined
): WorkspaceOnboardingSnapshotMetadata | null {
  const value = snapshot?.metadata?.[workspaceOnboardingMetadataKey];
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== workspaceOnboardingMetadataSchemaVersion ||
    !("autoOpened" in value) ||
    value.autoOpened !== true ||
    !("autoOpenedAt" in value) ||
    typeof value.autoOpenedAt !== "string"
  ) {
    return null;
  }

  return value as WorkspaceOnboardingSnapshotMetadata;
}
