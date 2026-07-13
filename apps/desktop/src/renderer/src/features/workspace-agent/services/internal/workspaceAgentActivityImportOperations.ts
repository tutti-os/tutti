import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import type { DesktopHostFilesApi } from "@preload/types";
import type { IWorkspaceAgentActivityService } from "../workspaceAgentActivityService.interface.ts";
import { normalizeWorkspaceId } from "./workspaceAgentActivityDiagnostics.ts";

export interface WorkspaceAgentActivityImportOperationsDependencies {
  hostFilesApi?: Pick<DesktopHostFilesApi, "selectAppArchive">;
  refreshActivity(workspaceId: string): Promise<unknown>;
  refreshUserProjects(): Promise<unknown> | undefined;
  tuttidClient: TuttidClient;
}

export class WorkspaceAgentActivityImportOperations {
  private readonly dependencies: WorkspaceAgentActivityImportOperationsDependencies;

  constructor(
    dependencies: WorkspaceAgentActivityImportOperationsDependencies
  ) {
    this.dependencies = dependencies;
  }

  scan(
    workspaceId: string,
    request?: Parameters<
      IWorkspaceAgentActivityService["scanExternalSessionImports"]
    >[1]
  ): ReturnType<IWorkspaceAgentActivityService["scanExternalSessionImports"]> {
    return this.dependencies.tuttidClient.scanWorkspaceExternalAgentSessionImports(
      normalizeWorkspaceId(workspaceId),
      request
    );
  }

  async import(
    workspaceId: string,
    request: Parameters<
      IWorkspaceAgentActivityService["importExternalSessions"]
    >[1]
  ): ReturnType<IWorkspaceAgentActivityService["importExternalSessions"]> {
    const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
    const result =
      await this.dependencies.tuttidClient.importWorkspaceExternalAgentSessions(
        normalizedWorkspaceId,
        request
      );
    await Promise.all([
      this.dependencies.refreshActivity(normalizedWorkspaceId),
      this.dependencies.refreshUserProjects()
    ]);
    return result;
  }

  async selectArchive(): Promise<string | null> {
    return (await this.dependencies.hostFilesApi?.selectAppArchive()) ?? null;
  }
}
