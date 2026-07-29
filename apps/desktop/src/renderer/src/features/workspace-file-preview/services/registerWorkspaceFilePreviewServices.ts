import { type ServiceRegistry } from "@tutti-os/infra/di";
import { WorkspaceFilePreviewSurfaceHost } from "./internal/workspaceFilePreviewSurfaceHost.ts";
import { IWorkspaceFilePreviewSurfaceHost } from "./workspaceFilePreviewSurfaceHost.interface.ts";

export function registerWorkspaceFilePreviewServices(
  registry: ServiceRegistry
): void {
  registry.registerInstance(
    IWorkspaceFilePreviewSurfaceHost,
    new WorkspaceFilePreviewSurfaceHost()
  );
}
