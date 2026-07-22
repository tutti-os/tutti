export type WorkspaceFilePreviewEntryKind =
  | "file"
  | "directory"
  | "folder"
  | "unknown"
  | (string & {});

export type WorkspaceFilePreviewKind = "image" | "text" | "video";

export type WorkspaceFileVisualKind =
  | "binary"
  | "code"
  | "directory"
  | "document"
  | "image"
  | "markdown"
  | "video";

export interface WorkspaceFilePreviewEntry {
  displayName?: string;
  kind: WorkspaceFilePreviewEntryKind;
  mtimeMs?: number | null;
  name?: string;
  path: string;
  sizeBytes?: number | null;
}

export interface WorkspaceFilePreviewActivationTarget {
  fileKind: WorkspaceFilePreviewKind;
  mtimeMs?: number | null;
  name: string;
  path: string;
  sizeBytes?: number | null;
}

export type WorkspaceFilePreviewReadonlyReason =
  | "binary"
  | "decode_failed"
  | "file_too_large"
  | "text_too_large";

export type WorkspaceFilePreviewReadiness<
  TEntry extends WorkspaceFilePreviewEntry,
  TTarget extends WorkspaceFilePreviewActivationTarget =
    WorkspaceFilePreviewActivationTarget
> =
  | { entry: TEntry; status: "directory" }
  | {
      entry: TEntry;
      maxSizeBytes: number;
      reason: Extract<
        WorkspaceFilePreviewReadonlyReason,
        "file_too_large" | "text_too_large"
      >;
      status: "readonly";
    }
  | { entry: TEntry; status: "unsupported" }
  | { entry: TEntry; status: "ready"; target: TTarget };

export type WorkspaceFilePreviewLoadedState<
  TEntry extends WorkspaceFilePreviewEntry,
  TTarget extends WorkspaceFilePreviewActivationTarget
> =
  | { content: string; entry: TTarget; status: "text" }
  | {
      bytes: Uint8Array<ArrayBuffer>;
      contentType: string;
      entry: TTarget;
      status: "image";
    }
  | {
      bytes: Uint8Array<ArrayBuffer>;
      contentType: string;
      entry: TTarget;
      status: "video";
    }
  | {
      entry: TEntry;
      maxSizeBytes?: number;
      reason: WorkspaceFilePreviewReadonlyReason;
      status: "readonly";
    };

const imageExtensions = new Set([
  "avif",
  "gif",
  "jpeg",
  "jpg",
  "png",
  "svg",
  "webp"
]);
const browserOpenableHtmlExtensions = new Set([
  "htm",
  "html",
  "shtml",
  "xhtml"
]);
const browserOpenableVideoExtensions = new Set(["mp4", "webm"]);

const videoExtensions = new Set([
  "avi",
  "m2ts",
  "mkv",
  "mov",
  "mp4",
  "mpeg",
  "mpg",
  "mts",
  "webm",
  "wmv"
]);
/**
 * Extensions where macOS Launch Services may register video handlers even when
 * the workspace file is source code (UTI / uniform type collisions).
 */
export const workspaceFileVideoHandlerCollisionExtensions = new Set(["ts"]);
const markdownExtensions = new Set(["md", "mdx"]);
const codeExtensions = new Set([
  "bash",
  "c",
  "cc",
  "conf",
  "cpp",
  "cs",
  "css",
  "go",
  "h",
  "hpp",
  "html",
  "java",
  "js",
  "jsx",
  "json",
  "lua",
  "m",
  "mm",
  "php",
  "plist",
  "proto",
  "py",
  "rb",
  "rs",
  "sh",
  "sql",
  "swift",
  "toml",
  "ts",
  "tsx",
  "xml",
  "yaml",
  "yml",
  "zsh"
]);
const documentExtensions = new Set([
  "csv",
  "doc",
  "docx",
  "log",
  "pdf",
  "rtf",
  "txt",
  "xls",
  "xlsx"
]);
const textExtensions = new Set([
  "bash",
  "c",
  "cc",
  "conf",
  "cpp",
  "cs",
  "css",
  "csv",
  "env",
  "go",
  "h",
  "hpp",
  "html",
  "ini",
  "java",
  "js",
  "json",
  "jsx",
  "log",
  "lua",
  "m",
  "md",
  "mdx",
  "mm",
  "php",
  "plist",
  "proto",
  "py",
  "rb",
  "rs",
  "sh",
  "sql",
  "swift",
  "toml",
  "ts",
  "tsx",
  "txt",
  "xml",
  "yaml",
  "yml",
  "zsh"
]);
const textFileNames = new Set([
  ".gitignore",
  ".npmrc",
  ".nvmrc",
  "dockerfile",
  "makefile",
  "readme"
]);

export const workspaceFileTextMaxBytes = 1024 * 1024;
export const workspaceFilePreviewMaxBytes = 20 * 1024 * 1024;

export function resolveWorkspaceFileVisualKind(
  entry: Pick<WorkspaceFilePreviewEntry, "kind" | "name" | "path">
): WorkspaceFileVisualKind {
  if (entry.kind === "directory" || entry.kind === "folder") {
    return "directory";
  }

  const extension = resolveWorkspaceFileExtension(
    entry.path || entry.name || ""
  );
  if (imageExtensions.has(extension)) {
    return "image";
  }
  if (videoExtensions.has(extension)) {
    return "video";
  }
  if (markdownExtensions.has(extension)) {
    return "markdown";
  }
  if (codeExtensions.has(extension)) {
    return "code";
  }
  if (documentExtensions.has(extension)) {
    return "document";
  }
  return "binary";
}

export function resolveWorkspaceFileExtension(pathOrName: string): string {
  const name = pathOrName.split("/").pop()?.trim().toLowerCase() ?? "";
  const dotIndex = name.lastIndexOf(".");
  return dotIndex > 0 ? name.slice(dotIndex + 1) : "";
}

export function isWorkspaceFileBrowserOpenable(
  entry: Pick<WorkspaceFilePreviewEntry, "kind" | "name" | "path">
): boolean {
  if (entry.kind !== "file") {
    return false;
  }

  const extension = resolveWorkspaceFileExtension(
    entry.path || entry.name || ""
  );
  if (
    extension === "pdf" ||
    browserOpenableHtmlExtensions.has(extension) ||
    imageExtensions.has(extension) ||
    browserOpenableVideoExtensions.has(extension)
  ) {
    return true;
  }

  return classifyWorkspaceFilePreviewKind(entry) === "text";
}

export function shouldFilterVideoPlayersForOpenWith(
  entry: Pick<WorkspaceFilePreviewEntry, "kind" | "name" | "path">
): boolean {
  if (entry.kind !== "file") {
    return false;
  }

  const visualKind = resolveWorkspaceFileVisualKind(entry);
  if (visualKind === "video") {
    return false;
  }

  const extension = resolveWorkspaceFileExtension(
    entry.path || entry.name || ""
  );
  if (workspaceFileVideoHandlerCollisionExtensions.has(extension)) {
    return true;
  }

  if (visualKind === "code" || visualKind === "markdown") {
    return true;
  }

  return classifyWorkspaceFilePreviewKind(entry) === "text";
}

export function resolveWorkspaceImageMimeType(
  pathOrName: string
): string | null {
  switch (resolveWorkspaceFileExtension(pathOrName)) {
    case "avif":
      return "image/avif";
    case "gif":
      return "image/gif";
    case "jpeg":
    case "jpg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "svg":
      return "image/svg+xml";
    case "webp":
      return "image/webp";
    default:
      return null;
  }
}

export function resolveWorkspaceVideoMimeType(
  pathOrName: string
): string | null {
  switch (resolveWorkspaceFileExtension(pathOrName)) {
    case "mp4":
      return "video/mp4";
    case "webm":
      return "video/webm";
    default:
      return null;
  }
}

export function classifyWorkspaceFilePreviewKind(
  entry: Pick<
    WorkspaceFilePreviewEntry,
    "displayName" | "kind" | "name" | "path"
  >
): WorkspaceFilePreviewKind | null {
  if (entry.kind !== "file") {
    return null;
  }

  const name = resolveWorkspaceFilePreviewName(entry);
  if (resolveWorkspaceImageMimeType(name) !== null) {
    return "image";
  }
  if (resolveWorkspaceVideoMimeType(name) !== null) {
    return "video";
  }

  const normalizedName = name.trim().toLowerCase();
  const extension = resolveWorkspaceFileExtension(name);
  if (textExtensions.has(extension) || textFileNames.has(normalizedName)) {
    return "text";
  }

  return null;
}

export function resolveWorkspaceFileActivationTarget(
  entry: WorkspaceFilePreviewEntry
): WorkspaceFilePreviewActivationTarget | null {
  const fileKind = classifyWorkspaceFilePreviewKind(entry);
  if (!fileKind) {
    return null;
  }

  const target: WorkspaceFilePreviewActivationTarget = {
    fileKind,
    name: resolveWorkspaceFilePreviewName(entry),
    path: entry.path
  };
  if (entry.mtimeMs !== undefined) {
    target.mtimeMs = entry.mtimeMs;
  }
  if (entry.sizeBytes !== undefined) {
    target.sizeBytes = entry.sizeBytes;
  }
  return target;
}

export function resolveWorkspaceFilePreviewReadiness<
  TEntry extends WorkspaceFilePreviewEntry
>(entry: TEntry): WorkspaceFilePreviewReadiness<TEntry> {
  if (entry.kind === "directory" || entry.kind === "folder") {
    return {
      entry,
      status: "directory"
    };
  }

  const target = resolveWorkspaceFileActivationTarget(entry);
  if (!target) {
    return {
      entry,
      status: "unsupported"
    };
  }

  if (
    target.fileKind === "text" &&
    isWorkspaceTextFileTooLarge(entry.sizeBytes)
  ) {
    return {
      entry,
      maxSizeBytes: workspaceFileTextMaxBytes,
      reason: "text_too_large",
      status: "readonly"
    };
  }

  if (isWorkspacePreviewFileTooLarge(entry.sizeBytes)) {
    return {
      entry,
      maxSizeBytes: workspaceFilePreviewMaxBytes,
      reason: "file_too_large",
      status: "readonly"
    };
  }

  return {
    entry,
    status: "ready",
    target
  };
}

export function createWorkspaceFilePreviewLoadedState<
  TEntry extends WorkspaceFilePreviewEntry,
  TTarget extends WorkspaceFilePreviewActivationTarget
>(input: {
  bytes: Uint8Array | ArrayBuffer;
  contentType?: string | null;
  entry: TEntry;
  target: TTarget;
}): WorkspaceFilePreviewLoadedState<TEntry, TTarget> {
  if (input.target.fileKind === "image") {
    return {
      bytes: copyWorkspaceFilePreviewBytes(input.bytes),
      contentType:
        input.contentType ??
        resolveWorkspaceImageMimeType(input.target.name) ??
        "application/octet-stream",
      entry: input.target,
      status: "image"
    };
  }
  if (input.target.fileKind === "video") {
    return {
      bytes: copyWorkspaceFilePreviewBytes(input.bytes),
      contentType:
        input.contentType ??
        resolveWorkspaceVideoMimeType(input.target.name) ??
        "application/octet-stream",
      entry: input.target,
      status: "video"
    };
  }

  try {
    const content = decodeWorkspaceTextFile(input.bytes);
    if (looksLikeBinaryText(content)) {
      return {
        entry: input.entry,
        reason: "binary",
        status: "readonly"
      };
    }
    return {
      content,
      entry: input.target,
      status: "text"
    };
  } catch {
    return {
      entry: input.entry,
      reason: "decode_failed",
      status: "readonly"
    };
  }
}

export function resolveWorkspaceFilePreviewName(
  entry: Pick<WorkspaceFilePreviewEntry, "displayName" | "name" | "path">
): string {
  return (
    entry.name?.trim() ||
    entry.displayName?.trim() ||
    entry.path.split("/").pop()?.trim() ||
    entry.path
  );
}

export function isWorkspaceTextFileTooLarge(
  sizeBytes?: number | null
): boolean {
  return (
    typeof sizeBytes === "number" &&
    Number.isFinite(sizeBytes) &&
    sizeBytes > workspaceFileTextMaxBytes
  );
}

export function isWorkspacePreviewFileTooLarge(
  sizeBytes?: number | null
): boolean {
  return (
    typeof sizeBytes === "number" &&
    Number.isFinite(sizeBytes) &&
    sizeBytes > workspaceFilePreviewMaxBytes
  );
}

export function decodeWorkspaceTextFile(
  bytes: Uint8Array | ArrayBuffer
): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(
    normalizeWorkspaceFilePreviewBytes(bytes)
  );
}

export function normalizeWorkspaceFilePreviewBytes(
  value: Uint8Array | ArrayBuffer
): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }
  return new Uint8Array(value);
}

export function copyWorkspaceFilePreviewBytes(
  bytes: Uint8Array | ArrayBuffer
): Uint8Array<ArrayBuffer> {
  const normalized = normalizeWorkspaceFilePreviewBytes(bytes);
  const buffer = new ArrayBuffer(normalized.byteLength);
  const copy = new Uint8Array(buffer);
  copy.set(normalized);
  return copy;
}

export function looksLikeBinaryText(content: string): boolean {
  if (content.length === 0) {
    return false;
  }

  const sample = content.slice(0, 4096);
  if (sample.includes("\u0000")) {
    return true;
  }

  let suspiciousControlChars = 0;
  for (let index = 0; index < sample.length; index += 1) {
    const code = sample.charCodeAt(index);
    const isAllowedWhitespace = code === 9 || code === 10 || code === 13;
    const isControlChar = code < 32 || (code >= 127 && code <= 159);
    if (isControlChar && !isAllowedWhitespace) {
      suspiciousControlChars += 1;
    }
  }

  return suspiciousControlChars / sample.length > 0.12;
}

export function formatWorkspacePreviewByteLimit(sizeBytes: number): string {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }

  const mebibytes = sizeBytes / (1024 * 1024);
  if (Number.isInteger(mebibytes)) {
    return `${mebibytes} MiB`;
  }
  return `${mebibytes.toFixed(1)} MiB`;
}
