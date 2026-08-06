import type { DesktopWorkspaceAppExternalRendererRequest } from "../../shared/contracts/ipc.ts";
import type { TuttiExternalAtQueryDirectoryInput } from "@tutti-os/workspace-external-core/contracts";
import type { WorkspaceAppGuestContext } from "./workspaceAppContextTypes.ts";

type WorkspaceAppAtQueryDirectoryRequest = Extract<
  DesktopWorkspaceAppExternalRendererRequest,
  { operation: "at.queryDirectory" }
>;

export function createWorkspaceAppAtQueryDirectoryRequest(input: {
  context: Pick<WorkspaceAppGuestContext, "appID" | "workspaceID">;
  query: TuttiExternalAtQueryDirectoryInput;
  requestId: string;
}): WorkspaceAppAtQueryDirectoryRequest {
  return {
    appId: input.context.appID,
    input: input.query,
    operation: "at.queryDirectory",
    requestId: input.requestId,
    workspaceId: input.context.workspaceID
  };
}
