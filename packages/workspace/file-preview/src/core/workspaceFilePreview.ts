/**
 * Preview readiness, byte decoding, and loaded-state construction.
 *
 * Ownership rules: packages/workspace/file-preview/CONTRACT.md
 */

import {
  classifyWorkspaceFilePreviewKind,
  isTextDegradablePreviewKind,
  resolveWorkspaceFileBuiltinRenderKind,
  resolveWorkspaceFilePreviewName,
  resolveWorkspaceFilePreviewTarget,
  resolveWorkspaceImageMimeType,
  resolveWorkspaceVideoMimeType,
  type WorkspaceFilePreviewEntry,
  type WorkspaceFilePreviewKind,
  type WorkspaceFilePreviewTarget
} from "./workspaceFilePreviewKinds.ts";

export * from "./workspaceFilePreviewKinds.ts";

export type WorkspaceFilePreviewReadonlyReason =
  | "binary"
  | "decode_failed"
  | "file_too_large"
  | "text_too_large";

export type WorkspaceFilePreviewReadiness<
  TEntry extends WorkspaceFilePreviewEntry,
  TTarget extends WorkspaceFilePreviewTarget = WorkspaceFilePreviewTarget
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
  | {
      entry: TEntry;
      previewKind: WorkspaceFilePreviewKind;
      status: "unsupported";
    }
  | { entry: TEntry; status: "ready"; target: TTarget };

export type WorkspaceFilePreviewLoadedState<
  TEntry extends WorkspaceFilePreviewEntry,
  TTarget extends WorkspaceFilePreviewTarget
> =
  | {
      content: string;
      entry: TTarget;
      previewKind: WorkspaceFilePreviewKind;
      status: "text";
    }
  | {
      bytes: Uint8Array<ArrayBuffer>;
      contentType: string;
      entry: TTarget;
      previewKind: "image";
      status: "image";
    }
  | {
      bytes: Uint8Array<ArrayBuffer>;
      contentType: string;
      entry: TTarget;
      previewKind: "video";
      status: "video";
    }
  | {
      bytes: Uint8Array<ArrayBuffer>;
      contentType: string | null;
      entry: TTarget;
      previewKind: WorkspaceFilePreviewKind;
      status: "bytes";
    }
  | {
      entry: TEntry;
      maxSizeBytes?: number;
      reason: WorkspaceFilePreviewReadonlyReason;
      status: "readonly";
    };

export interface ResolveWorkspaceFilePreviewReadinessOptions {
  /**
   * When true for a classified kind, readiness treats the entry as presentable
   * even if it is hook-only (pdf / audio / Office). Built-in presentable kinds
   * do not require this callback.
   */
  hasHostRenderer?: (kind: WorkspaceFilePreviewKind) => boolean;
}

export const workspaceFileTextMaxBytes = 1024 * 1024;
export const workspaceFilePreviewMaxBytes = 20 * 1024 * 1024;

export function resolveWorkspaceFilePreviewReadiness<
  TEntry extends WorkspaceFilePreviewEntry
>(
  entry: TEntry,
  options?: ResolveWorkspaceFilePreviewReadinessOptions
): WorkspaceFilePreviewReadiness<TEntry> {
  const previewKind = classifyWorkspaceFilePreviewKind(entry);
  if (previewKind === "directory") {
    return {
      entry,
      status: "directory"
    };
  }

  const builtin = resolveWorkspaceFileBuiltinRenderKind(previewKind);
  const hostRenderable =
    options?.hasHostRenderer?.(previewKind) === true &&
    previewKind !== "unsupported";

  if (!builtin && !hostRenderable) {
    return {
      entry,
      previewKind,
      status: "unsupported"
    };
  }

  const target =
    resolveWorkspaceFilePreviewTarget(entry) ??
    createWorkspaceFilePreviewTarget(entry, previewKind);

  if (
    (builtin === "text" || isTextDegradablePreviewKind(previewKind)) &&
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
  TTarget extends WorkspaceFilePreviewTarget
>(input: {
  bytes: Uint8Array | ArrayBuffer;
  contentType?: string | null;
  entry: TEntry;
  /**
   * When true, skip built-in text degradation and keep raw bytes for a host
   * renderer (hook-only kinds, or text-degradable kinds with a host hook).
   */
  preferHostBytes?: boolean;
  target: TTarget;
}): WorkspaceFilePreviewLoadedState<TEntry, TTarget> {
  const previewKind = input.target.previewKind;
  const builtin = resolveWorkspaceFileBuiltinRenderKind(previewKind);

  if (builtin === "image") {
    return {
      bytes: copyWorkspaceFilePreviewBytes(input.bytes),
      contentType:
        input.contentType ??
        resolveWorkspaceImageMimeType(input.target.name) ??
        "application/octet-stream",
      entry: input.target,
      previewKind: "image",
      status: "image"
    };
  }
  if (builtin === "video") {
    return {
      bytes: copyWorkspaceFilePreviewBytes(input.bytes),
      contentType:
        input.contentType ??
        resolveWorkspaceVideoMimeType(input.target.name) ??
        "application/octet-stream",
      entry: input.target,
      previewKind: "video",
      status: "video"
    };
  }

  if (input.preferHostBytes || builtin === null) {
    return {
      bytes: copyWorkspaceFilePreviewBytes(input.bytes),
      contentType: input.contentType ?? null,
      entry: input.target,
      previewKind,
      status: "bytes"
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
      previewKind,
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

function createWorkspaceFilePreviewTarget(
  entry: WorkspaceFilePreviewEntry,
  previewKind: WorkspaceFilePreviewKind
): WorkspaceFilePreviewTarget {
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
