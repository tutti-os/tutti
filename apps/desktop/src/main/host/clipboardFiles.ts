import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { clipboard, nativeImage } from "electron";
import { writeImageToClipboardWriter } from "./clipboardImageWriter.ts";
import { buildFilenamesPlist } from "./clipboardFilePlist.ts";

type SystemClipboardWriter = Pick<
  typeof clipboard,
  "clear" | "writeBuffer" | "writeImage"
>;
type NativeImageFactory = Pick<typeof nativeImage, "createFromBuffer">;

export interface SystemClipboardDependencies {
  clipboard?: SystemClipboardWriter;
  nativeImage?: NativeImageFactory;
}

export function writeImageToSystemClipboard(
  input: {
    data: string;
    mimeType: "image/png";
  },
  deps: SystemClipboardDependencies = {}
): void {
  const clipboardWriter = deps.clipboard ?? clipboard;
  const imageFactory = deps.nativeImage ?? nativeImage;
  writeImageToClipboardWriter(input, {
    clipboard: clipboardWriter,
    nativeImage: imageFactory
  });
}

export function writeFilesToSystemClipboard(
  filePaths: readonly string[],
  deps: SystemClipboardDependencies = {}
): void {
  const normalizedPaths = [
    ...new Set(
      filePaths
        .map((filePath) => filePath.trim())
        .filter(Boolean)
        .map((filePath) => path.resolve(filePath))
    )
  ];
  if (normalizedPaths.length === 0) {
    throw new Error("clipboard file paths are required");
  }

  const homeDirectory = path.resolve(homedir());
  for (const filePath of normalizedPaths) {
    accessSync(filePath, constants.F_OK);
    if (!isPathWithinRoot(homeDirectory, filePath)) {
      throw new Error(`clipboard path escapes allowed root: ${filePath}`);
    }
  }

  const clipboardWriter = deps.clipboard ?? clipboard;
  if (process.platform === "darwin") {
    clipboardWriter.clear();
    clipboardWriter.writeBuffer(
      "NSFilenamesPboardType",
      Buffer.from(buildFilenamesPlist(normalizedPaths))
    );
    return;
  }

  if (process.platform === "win32") {
    clipboardWriter.clear();
    clipboardWriter.writeBuffer(
      "CF_HDROP",
      buildCFHDropBuffer(normalizedPaths)
    );
    return;
  }

  throw new Error("clipboard file copy is unsupported on this platform");
}

function buildCFHDropBuffer(filePaths: readonly string[]): Buffer {
  const widePaths =
    filePaths.map((filePath) => `${path.win32.resolve(filePath)}\0`).join("") +
    "\0";
  const pathsBuffer = Buffer.from(widePaths, "utf16le");
  const header = Buffer.alloc(20);
  header.writeUInt32LE(20, 0);
  header.writeUInt32LE(1, 4);
  header.writeUInt32LE(0, 8);
  header.writeInt32LE(0, 12);
  header.writeInt32LE(0, 16);
  return Buffer.concat([header, pathsBuffer]);
}

function isPathWithinRoot(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  if (relative === "") {
    return true;
  }

  return !relative.startsWith("..") && !path.isAbsolute(relative);
}
