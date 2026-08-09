import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface CaptureComposerPosition {
  x: number;
  y: number;
}

export interface CaptureComposerPlacementStore {
  read(): Promise<CaptureComposerPosition | null>;
  write(position: CaptureComposerPosition): Promise<void>;
}

export function createCaptureComposerPlacementStore(
  filePath: string
): CaptureComposerPlacementStore {
  return {
    async read() {
      try {
        return parseCaptureComposerPosition(
          JSON.parse(await readFile(filePath, "utf8"))
        );
      } catch (error) {
        if (isMissingFileError(error)) {
          return null;
        }
        throw error;
      }
    },
    async write(position) {
      const normalized = parseCaptureComposerPosition(position);
      if (!normalized) {
        throw new Error("Screenshot composer position is invalid");
      }
      await mkdir(dirname(filePath), { recursive: true });
      const temporaryPath = `${filePath}.${process.pid}.tmp`;
      await writeFile(temporaryPath, JSON.stringify(normalized), {
        encoding: "utf8",
        mode: 0o600
      });
      await rename(temporaryPath, filePath);
    }
  };
}

export function parseCaptureComposerPosition(
  value: unknown
): CaptureComposerPosition | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const { x, y } = value as { x?: unknown; y?: unknown };
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    Math.abs(x) > 1_000_000 ||
    Math.abs(y) > 1_000_000
  ) {
    return null;
  }
  return { x: Math.round(x), y: Math.round(y) };
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
