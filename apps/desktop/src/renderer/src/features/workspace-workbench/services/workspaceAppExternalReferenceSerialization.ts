import type { TuttiExternalReferenceSelectResult } from "@tutti-os/workspace-external-core/contracts";
import type { ReferenceGroupedSelection } from "@tutti-os/workspace-file-reference/ui";

export function serializeWorkspaceAppExternalReferenceSelection(
  workspaceId: string,
  selection: ReferenceGroupedSelection
): TuttiExternalReferenceSelectResult {
  return [
    ...selection.files.map((reference) => ({
      selectionKind: "path" as const,
      reference
    })),
    ...selection.bundles.flatMap((bundle) => {
      const handle = bundle.handle;
      if (!handle || handle.source !== "app") {
        return [];
      }
      return [
        {
          selectionKind: "workspace-reference" as const,
          displayName: bundle.displayName,
          ...(bundle.fileCount > 0 ? { fileCount: bundle.fileCount } : {}),
          ...(handle.groupId ? { groupId: handle.groupId } : {}),
          id: handle.id,
          source: "app" as const,
          workspaceId
        }
      ];
    })
  ];
}
