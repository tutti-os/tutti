import "./lib/whyDidYouRender";
import * as React from "react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { TooltipProvider } from "@tutti-os/ui-system";
import { RendererApp } from "./app";
import { I18nProvider } from "./i18n";
import { NativeTooltipSuppressor } from "./lib/nativeTooltipSuppression";
import {
  createReactRootErrorLogger,
  createRenderStormTracker,
  installBrowserCrashLogging
} from "./lib/reactDiagnostics";
import { createRendererDiagnosticSink } from "./app/windows/createRendererDiagnosticsContainer";
import { DesktopToastProvider } from "./lib/toast";
import { registerDesktopModelMention } from "./features/workspace-agent/services/registerDesktopModelMention";
import { registerDesktopPastedTextMention } from "./features/workspace-agent/services/registerDesktopPastedTextMention";
import { registerBrowserElementMention } from "@tutti-os/agent-gui/workbench/browser-element-context";
import type { WorkspaceWindowContainerResult } from "./app/windows/workspace/createWorkspaceWindowContainer.ts";
import "./style.css";

// Register host-owned agent mention kinds before the first composer/transcript
// mounts (module-global registry; the agent-gui pipeline reads it during render).
registerDesktopPastedTextMention();
registerDesktopModelMention();
registerBrowserElementMention();

const root = document.querySelector<HTMLDivElement>("#app");

if (!root) {
  throw new Error("Renderer root element '#app' was not found.");
}

const logRendererDiagnostic = createRendererDiagnosticSink();

installBrowserCrashLogging({
  logRendererDiagnostic
});
const workspaceWindowContainer: WorkspaceWindowContainerResult = (
  await import("./app/windows/workspace/createWorkspaceWindowContainer.ts")
).createWorkspaceWindowContainer();

const rendererApp =
  import.meta.env.DEV && import.meta.env.VITE_TUTTI_REACT_PROFILER === "1" ? (
    createProfiledRendererApp(logRendererDiagnostic)
  ) : (
    <RendererApp workspaceWindowContainer={workspaceWindowContainer} />
  );
const logReactRootError = createReactRootErrorLogger({
  captureOwnerStack: React.captureOwnerStack,
  logRendererDiagnostic
});

function createProfiledRendererApp(
  logRendererDiagnostic: ReturnType<typeof createRendererDiagnosticSink>
): React.ReactElement {
  const renderStormTracker = createRenderStormTracker({
    logRendererDiagnostic
  });

  return (
    <React.Profiler
      id="TuttiRenderer"
      onRender={(
        id,
        phase,
        actualDuration,
        baseDuration,
        startTime,
        commitTime
      ) => {
        renderStormTracker.record({
          actualDuration,
          baseDuration,
          commitTime,
          id,
          phase,
          startTime
        });
      }}
    >
      <RendererApp workspaceWindowContainer={workspaceWindowContainer} />
    </React.Profiler>
  );
}

createRoot(root, {
  onCaughtError(error, errorInfo) {
    logReactRootError("caught", error, errorInfo);
  },
  onRecoverableError(error, errorInfo) {
    logReactRootError("recoverable", error, errorInfo);
  },
  onUncaughtError(error, errorInfo) {
    logReactRootError("uncaught", error, errorInfo);
  }
}).render(
  <StrictMode>
    <I18nProvider>
      <TooltipProvider>
        <NativeTooltipSuppressor />
        <DesktopToastProvider>{rendererApp}</DesktopToastProvider>
      </TooltipProvider>
    </I18nProvider>
  </StrictMode>
);
