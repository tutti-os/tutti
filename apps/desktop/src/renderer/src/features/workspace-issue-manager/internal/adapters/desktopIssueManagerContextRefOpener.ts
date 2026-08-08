import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import type {
  IssueManagerContextRefOpener,
  IssueManagerFileAdapter
} from "@tutti-os/workspace-issue-manager/contracts";
import type { DesktopHostFilesApi } from "@preload/types";

export function createDesktopIssueManagerContextRefOpener(input: {
  fileAdapter: IssueManagerFileAdapter;
  hostFilesApi: Pick<
    DesktopHostFilesApi,
    "archiveAgentPromptFile" | "openTerminalLink"
  >;
  tuttidClient: TuttidClient;
  workspaceId: string;
}): IssueManagerContextRefOpener {
  return {
    async openContextRef(reference) {
      if (reference.workspaceId !== input.workspaceId) {
        throw new Error("Issue attachment workspace does not match the host");
      }
      if (reference.accessKind === "workspace_path") {
        if (!reference.path.trim() || !input.fileAdapter.openReference) {
          return;
        }
        await input.fileAdapter.openReference({
          displayName: reference.displayName,
          kind: "file",
          path: reference.path
        });
        return;
      }

      const attachment = await input.tuttidClient.readWorkspaceIssueAttachment(
        reference.workspaceId,
        reference.issueId,
        reference.contextRefId
      );
      const archived = await input.hostFilesApi.archiveAgentPromptFile({
        dataBase64: attachment.data,
        displayName: attachment.displayName,
        mimeType: attachment.mimeType,
        workspaceID: reference.workspaceId
      });
      await input.hostFilesApi.openTerminalLink({
        path: archived.path,
        workspaceID: reference.workspaceId
      });
    }
  };
}
