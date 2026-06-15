import { join } from "node:path";
import type { DesktopWorkspaceAppPayload } from "../../shared/contracts/ipc";

export function resolveWorkspaceAppFolderPath(
  stateRootDir: string,
  payload: DesktopWorkspaceAppPayload
): string {
  const appID = safeWorkspaceAppPathSegment(payload.appId);
  switch (payload.folderKind) {
    case "workspace":
      return join(
        stateRootDir,
        "apps",
        "workspaces",
        safeWorkspaceAppPathSegment(payload.workspaceId),
        appID
      );
    case "data":
    case "logs":
    case "runtime":
      return join(
        stateRootDir,
        "apps",
        "workspaces",
        safeWorkspaceAppPathSegment(payload.workspaceId),
        appID,
        payload.folderKind
      );
    case "package": {
      const version = safeWorkspaceAppPathSegment(payload.version ?? "");
      if (version === "_") {
        throw new Error("workspace app package version is required");
      }
      return join(stateRootDir, "apps", "packages", appID, version);
    }
    default:
      throw new Error("unsupported workspace app folder kind");
  }
}

export function safeWorkspaceAppPathSegment(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "_";
  }

  const safe = Array.from(trimmed)
    .map((char) => (/^[\p{L}\p{N}_.-]$/u.test(char) ? char : "_"))
    .join("");
  return safe || "_";
}
