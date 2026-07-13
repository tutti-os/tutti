import { lazy, Suspense, type ReactNode } from "react";
import type { I18nRuntime } from "@tutti-os/ui-i18n-runtime";
import type { WorkbenchContribution } from "@tutti-os/workbench-surface";
import type { WorkspaceAgentActivityService } from "@renderer/features/workspace-agent";
import type { DesktopBrowserApi } from "@preload/types";
import type { useTranslation } from "@renderer/i18n";
import type { StandaloneAgentToolPanelId } from "./standaloneAgentToolSidebarModel.ts";
import { StandaloneAgentBrowserToolPanel } from "./StandaloneAgentBrowserToolPanel.tsx";
import { StandaloneAgentToolLoadingState } from "./StandaloneAgentToolLoadingState.tsx";

const LazyWorkspaceFileManagerPane = lazy(() =>
  import("@renderer/features/workspace-file-manager/ui/WorkspaceFileManagerPane.tsx").then(
    ({ WorkspaceFileManagerPane }) => ({
      default: WorkspaceFileManagerPane
    })
  )
);
const LazyStandaloneAgentAppCenterToolPanel = lazy(() =>
  import("./StandaloneAgentAppCenterToolPanel.tsx").then(
    ({ StandaloneAgentAppCenterToolPanel }) => ({
      default: StandaloneAgentAppCenterToolPanel
    })
  )
);
const LazyStandaloneAgentMessageCenterToolPanel = lazy(() =>
  import("./StandaloneAgentMessageCenterToolPanel.tsx").then(
    ({ StandaloneAgentMessageCenterToolPanel }) => ({
      default: StandaloneAgentMessageCenterToolPanel
    })
  )
);

export interface StandaloneAgentFileOpenRequest {
  path: string;
  requestID: string;
}

export function StandaloneAgentToolSidebarPanel({
  active,
  appI18n,
  activityService,
  browserApi,
  contributions,
  fileOpenRequest,
  i18n,
  locale,
  messageCenterOpen,
  onCloseMessageCenter,
  onOpenMessageCenterChat,
  panel,
  workspaceId
}: {
  active: boolean;
  appI18n: I18nRuntime<string>;
  activityService: WorkspaceAgentActivityService;
  browserApi?: DesktopBrowserApi;
  contributions: readonly WorkbenchContribution[] | undefined;
  fileOpenRequest: StandaloneAgentFileOpenRequest | null;
  i18n: I18nRuntime<string>;
  locale: ReturnType<typeof useTranslation>["locale"];
  messageCenterOpen: boolean;
  onCloseMessageCenter: () => void;
  onOpenMessageCenterChat: (input: {
    agentSessionId: string;
    provider: string;
  }) => void;
  panel: StandaloneAgentToolPanelId;
  workspaceId: string;
}): ReactNode {
  if (panel === "files") {
    return (
      <Suspense
        fallback={
          <StandaloneAgentToolLoadingState label={i18n.t("common.loading")} />
        }
      >
        <LazyWorkspaceFileManagerPane
          className="h-full"
          revealIntent={fileOpenRequest}
          workspaceID={workspaceId}
        />
      </Suspense>
    );
  }
  if (panel === "apps") {
    return (
      <Suspense
        fallback={
          <StandaloneAgentToolLoadingState label={i18n.t("common.loading")} />
        }
      >
        <LazyStandaloneAgentAppCenterToolPanel
          active={active}
          backLabel={i18n.t("workspace.appCenter.backToApps")}
          contributions={contributions}
          unavailableLabel={i18n.t(
            "workspace.agentGui.toolSidebar.unavailable"
          )}
          workspaceId={workspaceId}
        />
      </Suspense>
    );
  }
  if (panel === "messages") {
    return (
      <Suspense
        fallback={
          <StandaloneAgentToolLoadingState label={i18n.t("common.loading")} />
        }
      >
        <LazyStandaloneAgentMessageCenterToolPanel
          activityService={activityService}
          i18n={i18n}
          locale={locale}
          open={messageCenterOpen}
          workspaceId={workspaceId}
          onClose={onCloseMessageCenter}
          onOpenChat={onOpenMessageCenterChat}
        />
      </Suspense>
    );
  }
  if (panel === "browser") {
    return browserApi ? (
      <StandaloneAgentBrowserToolPanel
        appI18n={appI18n}
        browserApi={browserApi}
        hidden={!active}
        loadingLabel={i18n.t("common.loading")}
      />
    ) : null;
  }
  return null;
}
