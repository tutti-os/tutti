import type { ReferenceNode } from "../../../contracts/referenceSource.ts";

export interface ReferencePreviewDateTimeFormatOptions {
  locale?: string;
  timeZone?: string;
}

export function formatHierarchyTitle(
  hierarchy: readonly ReferenceNode[]
): string | null {
  if (hierarchy.length === 0) {
    return null;
  }
  return hierarchy.map((crumb) => crumb.displayName).join(" / ");
}

export function formatReferenceNodePathText(
  node: ReferenceNode,
  hierarchy: readonly ReferenceNode[] = []
): string {
  const decodedPath = decodeReferenceListFileNodeId(node.ref.nodeId);
  if (decodedPath) {
    return decodedPath;
  }
  if (node.kind === "folder" && node.ref.nodeId.startsWith("g:")) {
    return (
      formatHierarchyTitle(completeHierarchy(hierarchy, node)) ||
      node.displayName
    );
  }
  return node.contextLabel?.trim() || node.ref.nodeId;
}

export function formatReferencePreviewDateTime(
  ms: number,
  options: ReferencePreviewDateTimeFormatOptions = {}
): string {
  const timeZone =
    options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const formatter = new Intl.DateTimeFormat(options.locale, {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    timeZone,
    year: "numeric"
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(ms)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

export function resolveReferencePreviewTimestampMs(
  node: Pick<ReferenceNode, "createdTimeMs" | "mtimeMs">
): number | null {
  return (
    normalizedTimestampMs(node.createdTimeMs) ??
    normalizedTimestampMs(node.mtimeMs)
  );
}

export function resolveReferencePreviewSizeBytes(
  node: ReferenceNode,
  previewState: {
    node?: ReferenceNode;
    previewSizeBytes?: number | null;
    status?: string;
  }
): number | null {
  const metadataSize = normalizedSizeBytes(node.sizeBytes);
  if (metadataSize != null && metadataSize > 0) {
    return metadataSize;
  }
  if (
    previewState.node &&
    previewState.node.ref.sourceId === node.ref.sourceId &&
    previewState.node.ref.nodeId === node.ref.nodeId
  ) {
    const previewSize = normalizedSizeBytes(previewState.previewSizeBytes);
    if (previewSize != null && previewSize > 0) {
      return previewSize;
    }
  }
  return metadataSize;
}

function normalizedTimestampMs(ms: number | null | undefined): number | null {
  return typeof ms === "number" && Number.isFinite(ms) && ms >= 0 ? ms : null;
}

function completeHierarchy(
  hierarchy: readonly ReferenceNode[],
  node: ReferenceNode
): ReferenceNode[] {
  const last = hierarchy.at(-1);
  if (
    last &&
    last.ref.sourceId === node.ref.sourceId &&
    last.ref.nodeId === node.ref.nodeId
  ) {
    return [...hierarchy];
  }
  return [...hierarchy, node];
}

function decodeReferenceListFileNodeId(nodeId: string): string | null {
  if (!nodeId.startsWith("f:")) {
    return null;
  }
  try {
    const normalized = nodeId.slice(2).replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(
      normalized.length + ((4 - (normalized.length % 4)) % 4),
      "="
    );
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

function normalizedSizeBytes(
  sizeBytes: number | null | undefined
): number | null {
  return typeof sizeBytes === "number" &&
    Number.isFinite(sizeBytes) &&
    sizeBytes >= 0
    ? sizeBytes
    : null;
}
