import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  isPersistedFusionBusinessWindowBoundsState,
  type PersistedFusionBusinessWindowBoundsState
} from "./fusionBusinessWindowBounds.ts";

export interface FusionBusinessWindowBoundsStore {
  read(): Promise<PersistedFusionBusinessWindowBoundsState | null>;
  write(state: PersistedFusionBusinessWindowBoundsState): Promise<void>;
}

export function createFusionBusinessWindowBoundsStore(
  path: string
): FusionBusinessWindowBoundsStore {
  let writeQueue = Promise.resolve();
  return {
    async read() {
      try {
        const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
        return isPersistedFusionBusinessWindowBoundsState(parsed)
          ? parsed
          : null;
      } catch {
        return null;
      }
    },
    write(state) {
      const snapshot: PersistedFusionBusinessWindowBoundsState = {
        entries: { ...state.entries },
        version: 1
      };
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
