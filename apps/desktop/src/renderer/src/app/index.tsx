import { WorkspaceWindow } from "./windows/workspace/WorkspaceWindow";
import type { WorkspaceWindowContainerResult } from "./windows/workspace/createWorkspaceWindowContainer.ts";

export function RendererApp({
  workspaceWindowContainer
}: {
  workspaceWindowContainer: WorkspaceWindowContainerResult;
}) {
  return <WorkspaceWindow containerInput={workspaceWindowContainer} />;
}
