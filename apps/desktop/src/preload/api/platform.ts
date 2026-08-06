import { webUtils } from "electron";
import { homedir } from "node:os";
import { statSync } from "node:fs";
import type { DesktopPlatformApi } from "../types";

export function createPlatformDesktopApi(): DesktopPlatformApi {
  return {
    // Electron's app name is set in the main process (for example, "Tutti Dev"
    // in the development environment). Keep the renderer bound to that native
    // value instead of duplicating the product name in UI code.
    appName: process.env.TUTTI_DESKTOP_APP_NAME?.trim() ?? "",
    homeDirectory: homedir(),
    os: process.platform,
    resolveDroppedEntries(files: File[]) {
      return files.map((file) => {
        const path = webUtils.getPathForFile(file);
        let kind: "file" | "folder" = "file";
        try {
          kind = statSync(path).isDirectory() ? "folder" : "file";
        } catch {
          kind = "file";
        }
        return { path, kind };
      });
    },
    resolveDroppedPaths(files: File[]): string[] {
      return files.map((file) => webUtils.getPathForFile(file));
    }
  };
}
