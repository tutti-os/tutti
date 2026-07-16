import { lazy, Suspense } from "react";
import { StandaloneAgentStartupShell } from "@renderer/features/workspace-workbench/ui/StandaloneAgentStartupShell.tsx";
import type { WorkspaceWindowContainerResult } from "./createWorkspaceWindowContainer.ts";

const LazyDefaultWorkspaceWindow = lazy(() =>
  import("./DefaultWorkspaceWindow.tsx").then((module) => ({
    default: module.DefaultWorkspaceWindow
  }))
);
const LazyStandaloneAgentWorkspaceWindow = lazy(() =>
  import("./StandaloneAgentWorkspaceWindow.tsx").then((module) => ({
    default: module.StandaloneAgentWorkspaceWindow
  }))
);

export function WorkspaceWindow({
  containerInput
}: {
  containerInput: WorkspaceWindowContainerResult;
}) {
  const routeView =
    new URLSearchParams(window.location.search).get("view") || "workspace";
  const routeFallback =
    routeView === "agent" ? (
      <StandaloneAgentStartupShell />
    ) : (
      <main className="h-screen min-h-0 bg-background" />
    );

  return (
    <Suspense fallback={routeFallback}>
      {routeView === "agent" ? (
        <LazyStandaloneAgentWorkspaceWindow containerInput={containerInput} />
      ) : (
        <LazyDefaultWorkspaceWindow containerInput={containerInput} />
      )}
    </Suspense>
  );
}
