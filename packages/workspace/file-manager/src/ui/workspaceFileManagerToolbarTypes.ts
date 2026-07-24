import type { ReactElement } from "react";

export interface WorkspaceFileManagerToolbarTrailingActionsContext {
  currentDirectoryPath: string;
  isBusy: boolean;
  isLoading: boolean;
  isMutating: boolean;
}

export type RenderWorkspaceFileManagerToolbarTrailingActions = (
  context: WorkspaceFileManagerToolbarTrailingActionsContext
) => ReactElement | null;
