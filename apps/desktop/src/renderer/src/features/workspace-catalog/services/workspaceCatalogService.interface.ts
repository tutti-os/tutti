import { createDecorator } from "@tutti-os/infra/di";
import type { WorkspaceCatalogReadableStoreState } from "./workspaceCatalogTypes";

export interface IWorkspaceCatalogService {
  readonly _serviceBrand: undefined;
  readonly store: WorkspaceCatalogReadableStoreState;

  loadWorkspaceWindow(
    workspaceID: string | null,
    routeView: string
  ): Promise<void>;
  renameWorkspace(workspaceID: string, name: string): Promise<void>;
}

export const IWorkspaceCatalogService =
  createDecorator<IWorkspaceCatalogService>("workspace-catalog-service");
