import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import {
  ICON_WORKER_STDOUT_PREFIX,
  type IconWorkerRequestMessage,
  type IconWorkerResponseMessage
} from "./iconWorkerProtocol.ts";

type ElectronApp = typeof import("electron").app;
type ElectronNativeImage = typeof import("electron").nativeImage;

// Entry point for the child process spawned with `TUTTI_ROLE=icon-worker`.
// Reads newline-delimited JSON requests on stdin and replies on stdout. If a
// native call aborts the process, the parent observes the exit and recovers.
export function runIconWorkerProcess(): void {
  void start().catch((error) => {
    process.stderr.write(
      `[icon-worker] failed to start: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
    );
    process.exit(1);
  });
}

async function start(): Promise<void> {
  const { app, nativeImage } = await import("electron");
  // Run headless: no windows, no dock icon, no app-switcher presence.
  app.dock?.hide();
  await app.whenReady();

  const reader = createInterface({ input: process.stdin });
  reader.on("line", (line) => {
    void handleLine(line, app, nativeImage);
  });
  // When the parent goes away its end of the pipe closes; exit with it.
  reader.on("close", () => {
    app.quit();
  });
}

async function handleLine(
  line: string,
  app: ElectronApp,
  nativeImage: ElectronNativeImage
): Promise<void> {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }

  let request: IconWorkerRequestMessage;
  try {
    request = JSON.parse(trimmed) as IconWorkerRequestMessage;
  } catch {
    return;
  }

  let pngBase64: string | null = null;
  try {
    const bytes =
      request.mode === "fileIcon"
        ? await readFileIconPng(app, request.path, request.sizePx)
        : await readImageThumbnailPng(nativeImage, request.path, request.sizePx);
    pngBase64 = bytes ? bytes.toString("base64") : null;
  } catch {
    pngBase64 = null;
  }

  respond({ id: request.id, pngBase64 });
}

function respond(message: IconWorkerResponseMessage): void {
  process.stdout.write(
    `${ICON_WORKER_STDOUT_PREFIX}${JSON.stringify(message)}\n`
  );
}

async function readFileIconPng(
  app: ElectronApp,
  targetPath: string,
  sizePx: number
): Promise<Buffer | null> {
  if (process.platform !== "darwin" && process.platform !== "win32") {
    return null;
  }
  const icon = await app.getFileIcon(targetPath, { size: "large" });
  if (icon.isEmpty()) {
    return null;
  }
  return icon.resize({ height: sizePx, width: sizePx }).toPNG();
}

async function readImageThumbnailPng(
  nativeImage: ElectronNativeImage,
  targetPath: string,
  maxEdgePx: number
): Promise<Buffer | null> {
  let image = nativeImage.createFromPath(targetPath);
  if (image.isEmpty()) {
    image = nativeImage.createFromBuffer(await readFile(targetPath));
  }
  if (image.isEmpty()) {
    return null;
  }

  const sourceSize = image.getSize();
  if (!isValidImageSize(sourceSize)) {
    return null;
  }

  const scale = Math.min(
    1,
    maxEdgePx / Math.max(sourceSize.width, sourceSize.height)
  );
  const output =
    scale < 1
      ? image.resize({
          height: Math.max(1, Math.round(sourceSize.height * scale)),
          width: Math.max(1, Math.round(sourceSize.width * scale))
        })
      : image;
  if (output.isEmpty()) {
    return null;
  }
  return output.toPNG();
}

function isValidImageSize(size: { height: number; width: number }): boolean {
  return (
    Number.isFinite(size.height) &&
    Number.isFinite(size.width) &&
    size.height > 0 &&
    size.width > 0
  );
}
