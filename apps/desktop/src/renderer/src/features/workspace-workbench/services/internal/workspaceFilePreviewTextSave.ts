export interface WorkspaceFilePreviewTextSaveClient {
  writeWorkspaceFileText(
    workspaceID: string,
    request: {
      content: string;
      path: string;
    }
  ): Promise<unknown>;
}

export async function saveWorkspaceFilePreviewText(input: {
  content: string;
  path: string;
  tuttidClient: WorkspaceFilePreviewTextSaveClient;
  workspaceID: string;
}): Promise<void> {
  await input.tuttidClient.writeWorkspaceFileText(input.workspaceID, {
    content: input.content,
    path: input.path
  });
}
