import type { DesktopWorkspaceAppExternalRendererRequest } from "@shared/contracts/ipc";
import type { IWorkspaceWorkbenchHostService } from "./workspaceWorkbenchHostService.interface.ts";

type WorkspaceAppExternalAtRequest = Extract<
  DesktopWorkspaceAppExternalRendererRequest,
  { operation: "at.query" | "at.queryDirectory" | "at.resolve" }
>;

export function dispatchWorkspaceAppExternalAtRequest(input: {
  hostService: Pick<
    IWorkspaceWorkbenchHostService,
    | "queryWorkspaceAppExternalAt"
    | "queryWorkspaceAppExternalAtDirectory"
    | "resolveWorkspaceAppExternalAt"
  >;
  request: WorkspaceAppExternalAtRequest;
  workspaceId: string;
}) {
  switch (input.request.operation) {
    case "at.query":
      return input.hostService.queryWorkspaceAppExternalAt({
        query: input.request.input,
        workspaceId: input.workspaceId
      });
    case "at.queryDirectory":
      return input.hostService.queryWorkspaceAppExternalAtDirectory({
        query: input.request.input,
        workspaceId: input.workspaceId
      });
    case "at.resolve":
      return input.hostService.resolveWorkspaceAppExternalAt({
        mention: input.request.input,
        workspaceId: input.workspaceId
      });
  }
}
