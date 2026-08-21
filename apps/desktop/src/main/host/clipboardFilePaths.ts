import path from "node:path";

export function normalizeClipboardFilePaths(
  filePaths: readonly string[],
  platform: NodeJS.Platform = process.platform
): string[] {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  return [
    ...new Set(
      filePaths
        .map((filePath) => filePath.trim())
        .filter(Boolean)
        .map((filePath) =>
          platform === "win32" && /^\/[A-Za-z]:[\\/]/u.test(filePath)
            ? filePath.slice(1)
            : filePath
        )
        .map((filePath) => pathApi.resolve(filePath))
    )
  ];
}

export function buildWindowsFileDropBuffer(
  filePaths: readonly string[]
): Buffer {
  const widePaths =
    filePaths.map((filePath) => `${path.win32.resolve(filePath)}\0`).join("") +
    "\0";
  const pathsBuffer = Buffer.from(widePaths, "utf16le");
  const header = Buffer.alloc(20);
  header.writeUInt32LE(20, 0);
  header.writeInt32LE(0, 4);
  header.writeInt32LE(0, 8);
  header.writeInt32LE(0, 12);
  header.writeInt32LE(1, 16);
  return Buffer.concat([header, pathsBuffer]);
}
