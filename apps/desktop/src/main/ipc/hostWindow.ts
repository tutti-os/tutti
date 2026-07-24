import { screen } from "electron";
import {
  captureWorkbenchDockPreview,
  type WorkbenchDockPreviewCaptureDiagnostic
} from "@tutti-os/workbench-electron";
import {
  desktopIpcChannels,
  type DesktopHostOpenAgentWindowInput,
  type DesktopHostWindowCapturePreviewInput
} from "../../shared/contracts/ipc";
import { createDesktopWindowAccess } from "../host/desktopWindowAccess";
import type { WorkspaceLaunch } from "../host/workspaceLaunch";
import { getDesktopLogger, type DesktopLogger } from "../logging";
import { registerDesktopIpcHandler } from "./handle";
import { resolveOwnerWindowFromEvent } from "./ownerWindow";
import { getWorkspaceWindowKind } from "../windows/workspaceWindow";
import {
  resolveStandaloneAgentWindowContentWidth,
  shouldAnimateStandaloneAgentWindowResize
} from "../windows/standaloneAgentWindowBounds";
import { toggleHostWindowMaximize } from "../windows/hostWindowMaximize";

const capturePreviewTimeoutMs = 2_000;
let capturePreviewSequence = 0;

export interface HostWindowIpcDependencies {
  workspaceLaunch: Pick<WorkspaceLaunch, "showAgentWindow">;
}

export function registerHostWindowIpc(deps: HostWindowIpcDependencies): void {
  const windowAccess = createDesktopWindowAccess();
  const logger = getDesktopLogger();

  registerDesktopIpcHandler(
    desktopIpcChannels.host.window.approveClose,
    (event) => windowAccess.approveClose(resolveOwnerWindowFromEvent(event))
  );

  registerDesktopIpcHandler(
    desktopIpcChannels.host.window.capturePreview,
    async (event, input) => {
      const ownerWindow = resolveOwnerWindowFromEvent(event);
      if (
        !ownerWindow ||
        ownerWindow.isDestroyed() ||
        ownerWindow.webContents.isDestroyed()
      ) {
        logger.warn("host window preview capture skipped", {
          reason: "owner_window_unavailable"
        });
        return null;
      }

      const contentBounds = ownerWindow.getContentBounds();
      const captureId = ++capturePreviewSequence;

      return captureWorkbenchDockPreview({
        contentSize: {
          height: contentBounds.height,
          width: contentBounds.width
        },
        maxHeight: input.maxHeight,
        maxWidth: input.maxWidth,
        onDiagnostic: (diagnostic) => {
          logCapturePreviewDiagnostic({
            captureId,
            contentBounds,
            diagnostic,
            input,
            logger
          });
        },
        rect: input.rect,
        timeoutMs: capturePreviewTimeoutMs,
        webContents: ownerWindow.webContents
      });
    }
  );

  registerDesktopIpcHandler(
    desktopIpcChannels.host.window.openAgentWindow,
    async (event, input) => {
      const ownerWindow = resolveOwnerWindowFromEvent(event);
      await deps.workspaceLaunch.showAgentWindow(
        normalizeAgentWindowInput(
          input,
          ownerWindow?.getBounds() ?? null,
          ownerWindow ? getWorkspaceWindowKind(ownerWindow) : null
        )
      );
      if (!ownerWindow || ownerWindow.isDestroyed()) {
        return;
      }

      if (input.minimizeSourceWindow !== false) {
        ownerWindow.minimize();
      }
    }
  );

  registerDesktopIpcHandler(
    desktopIpcChannels.host.window.minimize,
    (event) => {
      const ownerWindow = resolveOwnerWindowFromEvent(event);
      if (!ownerWindow || ownerWindow.isDestroyed()) {
        return;
      }

      ownerWindow.minimize();
    }
  );

  registerDesktopIpcHandler(
    desktopIpcChannels.host.window.resizeContentWidth,
    (event, input) => {
      const ownerWindow = resolveOwnerWindowFromEvent(event);
      if (!ownerWindow || ownerWindow.isDestroyed()) {
        return { width: 0 };
      }

      const currentBounds = ownerWindow.getContentBounds();
      if (ownerWindow.isFullScreen() || ownerWindow.isMaximized()) {
        return { width: currentBounds.width };
      }

      const workArea = screen.getDisplayMatching(
        ownerWindow.getBounds()
      ).workArea;
      const nextBounds = resolveStandaloneAgentWindowContentWidth({
        currentBounds,
        minWidth: ownerWindow.getMinimumSize()[0] ?? 1,
        requestedWidth: input.width,
        workArea
      });
      const animate = shouldAnimateStandaloneAgentWindowResize(
        process.platform,
        input.animate === true
      );
      ownerWindow.setContentBounds(nextBounds, animate);
      return { width: ownerWindow.getContentBounds().width };
    }
  );

  registerDesktopIpcHandler(
    desktopIpcChannels.host.window.toggleMaximize,
    (event) => {
      const ownerWindow = resolveOwnerWindowFromEvent(event);
      if (!ownerWindow || ownerWindow.isDestroyed()) {
        return;
      }

      toggleHostWindowMaximize(
        ownerWindow,
        getWorkspaceWindowKind(ownerWindow)
      );
    }
  );
}

function normalizeAgentWindowInput(
  input: DesktopHostOpenAgentWindowInput,
  openerBounds: Electron.Rectangle | null,
  openerWindowKind: "agent" | "workspace" | null
) {
  const workspaceID = input.workspaceId.trim();
  if (!workspaceID) {
    throw new Error("workspaceId is required to open an agent window");
  }
  return {
    agentDirectorySnapshot: input.agentDirectorySnapshot ?? null,
    agentSessionID: input.agentSessionId?.trim() || null,
    agentTargetID: input.agentTargetId?.trim() || null,
    autoSubmit: input.autoSubmit === true,
    draftPrompt: input.draftPrompt?.trim() || null,
    openerBounds,
    openerWindowKind,
    offsetFromSourceWindow: input.offsetFromSourceWindow === true,
    providerStatusSnapshot: input.providerStatusSnapshot ?? null,
    provider: input.provider?.trim() || null,
    userProjectPath: input.userProjectPath?.trim() || null,
    workspaceID
  };
}

function logCapturePreviewDiagnostic(input: {
  captureId: number;
  contentBounds: { height: number; width: number };
  diagnostic: WorkbenchDockPreviewCaptureDiagnostic;
  input: DesktopHostWindowCapturePreviewInput;
  logger: DesktopLogger;
}): void {
  const fields = {
    captureId: input.captureId,
    reason: input.diagnostic.reason
  };
  switch (input.diagnostic.reason) {
    case "invalid_rect":
      input.logger.warn("host window preview capture skipped", {
        ...fields,
        inputRect: input.input.rect,
        ownerWindowHeight: input.contentBounds.height,
        ownerWindowWidth: input.contentBounds.width
      });
      return;
    case "web_contents_destroyed_before_capture":
      input.logger.warn("host window preview capture skipped", {
        ...fields,
        reason: "owner_window_destroyed_before_capture"
      });
      return;
    case "capture_page_timeout":
      input.logger.warn("host window preview capture timed out", {
        ...fields,
        timeoutMs: capturePreviewTimeoutMs
      });
      return;
    case "capture_page_failed":
      input.logger.warn("host window preview capture failed", {
        ...fields,
        error:
          input.diagnostic.error instanceof Error
            ? input.diagnostic.error.message
            : String(input.diagnostic.error)
      });
      return;
    case "full_capture_empty":
      input.logger.warn("host window preview capture returned empty image", {
        ...fields
      });
      return;
    case "crop_empty":
      input.logger.warn(
        "host window preview capture crop returned empty image",
        {
          ...fields,
          cropRect: input.diagnostic.cropRect,
          imageHeight: input.diagnostic.imageSize?.height,
          imageWidth: input.diagnostic.imageSize?.width,
          requestedRect: input.input.rect
        }
      );
      return;
    case "resize_empty":
      input.logger.warn(
        "host window preview capture resize returned empty image",
        fields
      );
      return;
    case "data_url_empty":
      input.logger.warn(
        "host window preview capture returned empty data URL",
        fields
      );
  }
}
