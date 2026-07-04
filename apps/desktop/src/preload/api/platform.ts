import { webUtils } from "electron";
import { homedir } from "node:os";
import { statSync } from "node:fs";
import type { DesktopPlatformApi } from "../types";

export function createPlatformDesktopApi(): DesktopPlatformApi {
  return {
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
