/**
 * Preview kind taxonomy and classification.
 *
 * Ownership rules: packages/workspace/file-preview/CONTRACT.md
 */

export type WorkspaceFilePreviewEntryKind =
  | "file"
  | "directory"
  | "folder"
  | "unknown"
  | (string & {});

/**
 * Flat preview routing kind. Built-in surface covers image / video / text;
 * text-degradable kinds fall back to built-in text when no host hook is
 * registered. Hook-only kinds (audio / pdf / Office) stay unsupported until a
 * host registers a renderer.
 */
export type WorkspaceFilePreviewKind =
  | "directory"
  | "image"
  | "video"
  | "audio"
  | "text"
  | "code"
  | "markdown"
  | "json"
  | "csv"
  | "html"
  | "pdf"
  | "docx"
  | "xlsx"
  | "pptx"
  | "unsupported";

/** Coarse glyph / icon signal; must not be collapsed into previewKind. */
export type WorkspaceFileVisualKind =
  | "binary"
  | "code"
  | "directory"
  | "document"
  | "image"
  | "markdown"
  | "video";

/** Built-in render modes the package surface can paint without host hooks. */
export type WorkspaceFileBuiltinRenderKind = "image" | "text" | "video";

export interface WorkspaceFilePreviewEntry {
  kind: WorkspaceFilePreviewEntryKind;
  mtimeMs?: number | null;
  name?: string;
  path: string;
  sizeBytes?: number | null;
}

export interface WorkspaceFilePreviewTarget {
  previewKind: WorkspaceFilePreviewKind;
  mtimeMs?: number | null;
  name: string;
  path: string;
  sizeBytes?: number | null;
}

const imageExtensions = new Set([
  "avif",
  "gif",
  "jpeg",
  "jpg",
  "png",
  "svg",
  "webp"
]);

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

/** Browser-decodable video subset used for mime hints and open-with hosts. */
export const workspaceFileBrowserVideoExtensions = new Set(["mp4", "webm"]);

const audioExtensions = new Set([
  "aac",
  "flac",
  "m4a",
  "mp3",
  "oga",
  "ogg",
  "opus",
  "wav"
]);

const markdownExtensions = new Set(["md", "mdx"]);
const jsonExtensions = new Set(["json", "jsonc"]);
const csvExtensions = new Set(["csv", "tsv"]);
const htmlExtensions = new Set(["htm", "html", "shtml", "xhtml"]);
const pdfExtensions = new Set(["pdf"]);
const docxExtensions = new Set(["docx"]);
const xlsxExtensions = new Set(["xlsx"]);
const pptxExtensions = new Set(["pptx"]);

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
  "ini",
  "java",
  "js",
  "jsx",
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

const plainTextExtensions = new Set(["env", "log", "txt"]);

const textFileNames = new Set([
  ".gitignore",
  ".npmrc",
  ".nvmrc",
  "dockerfile",
  "makefile",
  "readme"
]);

/** Document-like icons that are not themselves first-class preview kinds. */
const documentVisualExtensions = new Set([
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

const textDegradablePreviewKinds = new Set<WorkspaceFilePreviewKind>([
  "text",
  "code",
  "markdown",
  "json",
  "csv",
  "html"
]);

export function resolveWorkspaceFileExtension(pathOrName: string): string {
  const name = pathOrName.split("/").pop()?.trim().toLowerCase() ?? "";
  const dotIndex = name.lastIndexOf(".");
  return dotIndex > 0 ? name.slice(dotIndex + 1) : "";
}

export function resolveWorkspaceFilePreviewName(
  entry: Pick<WorkspaceFilePreviewEntry, "name" | "path">
): string {
  return (
    entry.name?.trim() || entry.path.split("/").pop()?.trim() || entry.path
  );
}

export function isWorkspaceFileDirectoryKind(
  kind: WorkspaceFilePreviewEntryKind
): boolean {
  return kind === "directory" || kind === "folder";
}

export function isTextDegradablePreviewKind(
  kind: WorkspaceFilePreviewKind
): boolean {
  return textDegradablePreviewKinds.has(kind);
}

/**
 * Maps a classified preview kind onto the built-in surface renderer, if any.
 * Text-degradable kinds resolve to built-in `text`.
 */
export function resolveWorkspaceFileBuiltinRenderKind(
  kind: WorkspaceFilePreviewKind
): WorkspaceFileBuiltinRenderKind | null {
  if (kind === "image" || kind === "video") {
    return kind;
  }
  if (isTextDegradablePreviewKind(kind)) {
    return "text";
  }
  return null;
}

export function resolveWorkspaceFileVisualKind(
  entry: Pick<WorkspaceFilePreviewEntry, "kind" | "name" | "path">
): WorkspaceFileVisualKind {
  if (isWorkspaceFileDirectoryKind(entry.kind)) {
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
  if (codeExtensions.has(extension) || jsonExtensions.has(extension)) {
    return "code";
  }
  if (
    documentVisualExtensions.has(extension) ||
    htmlExtensions.has(extension) ||
    pptxExtensions.has(extension)
  ) {
    return "document";
  }
  return "binary";
}

/**
 * Classifies the flat previewKind for an entry.
 * Directory synonyms (`folder`) are normalized to `directory`.
 */
export function classifyWorkspaceFilePreviewKind(
  entry: Pick<WorkspaceFilePreviewEntry, "kind" | "name" | "path">
): WorkspaceFilePreviewKind {
  if (isWorkspaceFileDirectoryKind(entry.kind)) {
    return "directory";
  }
  if (entry.kind !== "file") {
    return "unsupported";
  }

  const name = resolveWorkspaceFilePreviewName(entry);
  const extension = resolveWorkspaceFileExtension(name);
  const normalizedName = name.trim().toLowerCase();

  if (imageExtensions.has(extension)) {
    return "image";
  }
  if (videoExtensions.has(extension)) {
    return "video";
  }
  if (audioExtensions.has(extension)) {
    return "audio";
  }
  if (markdownExtensions.has(extension)) {
    return "markdown";
  }
  if (jsonExtensions.has(extension)) {
    return "json";
  }
  if (csvExtensions.has(extension)) {
    return "csv";
  }
  if (htmlExtensions.has(extension)) {
    return "html";
  }
  if (pdfExtensions.has(extension)) {
    return "pdf";
  }
  if (docxExtensions.has(extension)) {
    return "docx";
  }
  if (xlsxExtensions.has(extension)) {
    return "xlsx";
  }
  if (pptxExtensions.has(extension)) {
    return "pptx";
  }
  if (codeExtensions.has(extension)) {
    return "code";
  }
  if (plainTextExtensions.has(extension) || textFileNames.has(normalizedName)) {
    return "text";
  }

  return "unsupported";
}

/**
 * Returns a preview target when the entry can be presented with the built-in
 * resolve chain (host hook omitted). Hook-only kinds return null here; hosts
 * with renderers should call classify + hasHostRenderer themselves.
 */
export function resolveWorkspaceFilePreviewTarget(
  entry: WorkspaceFilePreviewEntry
): WorkspaceFilePreviewTarget | null {
  const previewKind = classifyWorkspaceFilePreviewKind(entry);
  if (resolveWorkspaceFileBuiltinRenderKind(previewKind) === null) {
    return null;
  }

  const target: WorkspaceFilePreviewTarget = {
    previewKind,
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

export function isWorkspaceFileBrowserHtmlExtension(
  extension: string
): boolean {
  return htmlExtensions.has(extension);
}

export function isWorkspaceFileImageExtension(extension: string): boolean {
  return imageExtensions.has(extension);
}
