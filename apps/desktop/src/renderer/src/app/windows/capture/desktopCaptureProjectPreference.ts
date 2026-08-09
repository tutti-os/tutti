export interface DesktopCaptureProjectPreference {
  read(workspaceId: string): string | null;
  write(workspaceId: string, path: string | null): void;
}

const captureProjectPreferenceKeyPrefix =
  "tutti.desktop-capture.preferred-project.v1:";

export function createDesktopCaptureProjectPreference(
  storage: Pick<Storage, "getItem" | "removeItem" | "setItem"> | null
): DesktopCaptureProjectPreference {
  return {
    read(workspaceId) {
      if (!storage) {
        return null;
      }
      try {
        return (
          storage.getItem(captureProjectPreferenceKey(workspaceId))?.trim() ||
          null
        );
      } catch {
        return null;
      }
    },
    write(workspaceId, path) {
      if (!storage) {
        return;
      }
      const normalizedPath = path?.trim() ?? "";
      try {
        if (!normalizedPath) {
          storage.removeItem(captureProjectPreferenceKey(workspaceId));
          return;
        }
        storage.setItem(
          captureProjectPreferenceKey(workspaceId),
          normalizedPath
        );
      } catch {
        // The capture remains usable when browser persistence is unavailable.
      }
    }
  };
}

function captureProjectPreferenceKey(workspaceId: string): string {
  return `${captureProjectPreferenceKeyPrefix}${workspaceId}`;
}
