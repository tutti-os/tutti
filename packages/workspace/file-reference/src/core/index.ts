import type { WorkspaceFileReference } from "../contracts/index.ts";

export * from "./referenceSourceUtils.ts";
export * from "./referenceSourceAggregator.ts";
export * from "./referenceListSource.ts";
export * from "./referenceFilterCategories.ts";

export function uniqueWorkspaceFileReferences(
  refs: readonly WorkspaceFileReference[]
): WorkspaceFileReference[] {
  const unique = new Map<string, WorkspaceFileReference>();
  for (const ref of refs) {
    const normalizedPath = ref.path.trim();
    if (!normalizedPath || unique.has(normalizedPath)) {
      continue;
    }
    unique.set(normalizedPath, {
      displayName: ref.displayName?.trim() || undefined,
      kind: ref.kind === "folder" ? "folder" : "file",
      path: normalizedPath,
      ...(ref.createdTimeMs === undefined
        ? {}
        : { createdTimeMs: ref.createdTimeMs }),
      ...(ref.mtimeMs === undefined ? {} : { mtimeMs: ref.mtimeMs }),
      ...(ref.sizeBytes === undefined ? {} : { sizeBytes: ref.sizeBytes })
    });
  }
  return [...unique.values()];
}
