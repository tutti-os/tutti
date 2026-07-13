import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  isPersistedFusionDockBounds,
  type PersistedFusionDockBounds
} from "./fusionDockBounds.ts";

export interface FusionDockBoundsStore {
  read(): Promise<PersistedFusionDockBounds | null>;
  write(bounds: PersistedFusionDockBounds): Promise<void>;
}

export function createFusionDockBoundsStore(
  path: string
): FusionDockBoundsStore {
  let writeQueue = Promise.resolve();
  return {
    async read() {
      try {
        const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
        return isPersistedFusionDockBounds(parsed) ? parsed : null;
      } catch {
        return null;
      }
    },
    write(bounds) {
      const snapshot = { ...bounds };
      writeQueue = writeQueue
        .catch(() => undefined)
        .then(async () => {
          await mkdir(dirname(path), { recursive: true });
          const tempPath = `${path}.tmp`;
          await writeFile(tempPath, JSON.stringify(snapshot), "utf8");
          await rename(tempPath, path);
        });
      return writeQueue;
    }
  };
}
