import "./lib/whyDidYouRender";
import * as React from "react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { TooltipProvider } from "@tutti-os/ui-system";
import { resolveDesktopWindowIntent } from "@shared/contracts/windowIntent.ts";
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
import { registerDesktopPastedTextMention } from "./features/workspace-agent/services/registerDesktopPastedTextMention";
import "./style.css";

// Register host-owned agent mention kinds before the first composer/transcript
// mounts (module-global registry; the agent-gui pipeline reads it during render).
registerDesktopPastedTextMention();

const rendererWindowIntent = resolveDesktopWindowIntent(window.location.search);
document.documentElement.dataset.tuttiWindowSurface =
  rendererWindowIntent.kind === "fusion-dock" ? "transparent" : "opaque";

const root = document.querySelector<HTMLDivElement>("#app");

if (!root) {
  throw new Error("Renderer root element '#app' was not found.");
}

if (rendererWindowIntent.kind === "fusion-dock") {
  const transparentWindowCanvasClasses = [
    "min-w-0",
    "w-full",
    "h-full",
    "min-h-0",
    "overflow-hidden",
    "bg-none",
    "bg-transparent"
  ];
  for (const element of [document.documentElement, document.body, root]) {
    element.classList.add(...transparentWindowCanvasClasses);
  }
}

const logRendererDiagnostic = createRendererDiagnosticSink();

installBrowserCrashLogging({
  logRendererDiagnostic
});

const rendererApp =
  import.meta.env.DEV && import.meta.env.VITE_TUTTI_REACT_PROFILER === "1" ? (
    createProfiledRendererApp(logRendererDiagnostic)
  ) : (
    <RendererApp />
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
      <RendererApp />
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
