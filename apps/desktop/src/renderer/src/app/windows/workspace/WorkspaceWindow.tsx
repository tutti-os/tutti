import { lazy, Suspense } from "react";

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

export function WorkspaceWindow() {
  const routeView =
    new URLSearchParams(window.location.search).get("view") || "workspace";

  return (
    <Suspense fallback={<main className="h-screen min-h-0 bg-background" />}>
      {routeView === "agent" ? (
        <LazyStandaloneAgentWorkspaceWindow />
      ) : (
        <LazyDefaultWorkspaceWindow />
      )}
    </Suspense>
  );
}
