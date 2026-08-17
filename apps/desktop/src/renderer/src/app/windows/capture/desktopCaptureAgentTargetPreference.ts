export interface DesktopCaptureAgentTargetPreference {
  read(workspaceId: string): string | null;
  write(workspaceId: string, agentTargetId: string): void;
}

const captureAgentTargetPreferenceKeyPrefix =
  "tutti.desktop-capture.preferred-agent-target.v1:";

export function createDesktopCaptureAgentTargetPreference(
  storage: Pick<Storage, "getItem" | "setItem"> | null
): DesktopCaptureAgentTargetPreference {
  return {
    read(workspaceId) {
      if (!storage) {
        return null;
      }
      try {
        return (
          storage
            .getItem(captureAgentTargetPreferenceKey(workspaceId))
            ?.trim() || null
        );
      } catch {
        return null;
      }
    },
    write(workspaceId, agentTargetId) {
      if (!storage) {
        return;
      }
      const normalizedAgentTargetId = agentTargetId.trim();
      if (!normalizedAgentTargetId) {
        return;
      }
      try {
        storage.setItem(
          captureAgentTargetPreferenceKey(workspaceId),
          normalizedAgentTargetId
        );
      } catch {
        // The capture remains usable when browser persistence is unavailable.
      }
    }
  };
}

export function resolveDesktopCapturePreferenceStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function captureAgentTargetPreferenceKey(workspaceId: string): string {
  return `${captureAgentTargetPreferenceKeyPrefix}${workspaceId}`;
}
