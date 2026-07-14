import { lazy, Suspense, type ReactNode } from "react";
import type { I18nRuntime } from "@tutti-os/ui-i18n-runtime";
import type {
  WorkbenchContribution,
  WorkbenchHostHandle
} from "@tutti-os/workbench-surface";
import type { WorkspaceAgentActivityService } from "@renderer/features/workspace-agent";
import type { DesktopBrowserApi } from "@preload/types";
import type { useTranslation } from "@renderer/i18n";
import type { StandaloneAgentIssueManagerOpenRequest } from "../services/standaloneAgentIssueManagerLaunch.ts";
import type {
  StandaloneAgentSharedToolPanelId,
  StandaloneAgentToolPanelId
} from "./standaloneAgentToolSidebarModel.ts";
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
const LazyStandaloneAgentIssueManagerToolPanel = lazy(() =>
  import("./StandaloneAgentIssueManagerToolPanel.tsx").then(
    ({ StandaloneAgentIssueManagerToolPanel }) => ({
      default: StandaloneAgentIssueManagerToolPanel
    })
  )
);
const LazyStandaloneAgentTerminalPanel = lazy(() =>
  import("./StandaloneAgentTerminalPanel.tsx").then(
    ({ StandaloneAgentTerminalPanel }) => ({
      default: StandaloneAgentTerminalPanel
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
  issueManagerOpenRequest,
  i18n,
  locale,
  messageCenterOpen,
  onCloseMessageCenter,
  onOpenMessageCenterChat,
  panel,
  setToolHost,
  workspaceId
}: {
  active: boolean;
  appI18n: I18nRuntime<string>;
  activityService: WorkspaceAgentActivityService;
  browserApi?: DesktopBrowserApi;
  contributions: readonly WorkbenchContribution[] | undefined;
  fileOpenRequest: StandaloneAgentFileOpenRequest | null;
  issueManagerOpenRequest: StandaloneAgentIssueManagerOpenRequest | null;
  i18n: I18nRuntime<string>;
  locale: ReturnType<typeof useTranslation>["locale"];
  messageCenterOpen: boolean;
  onCloseMessageCenter: () => void;
  onOpenMessageCenterChat: (input: {
    agentSessionId: string;
    provider: string;
  }) => void;
  panel: StandaloneAgentToolPanelId;
  setToolHost: (
    panel: StandaloneAgentSharedToolPanelId,
    host: WorkbenchHostHandle | null
  ) => void;
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
          showPreviewPanel={false}
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
            "workspace.agentGui.toolSidebar.unavailable",
            { tool: i18n.t("workspace.agentGui.toolSidebar.apps") }
          )}
          workspaceId={workspaceId}
        />
      </Suspense>
    );
  }
  if (panel === "tasks") {
    return (
      <Suspense
        fallback={
          <StandaloneAgentToolLoadingState label={i18n.t("common.loading")} />
        }
      >
        <LazyStandaloneAgentIssueManagerToolPanel
          active={active}
          activation={issueManagerOpenRequest?.activation ?? null}
          contributions={contributions}
          unavailableLabel={i18n.t(
            "workspace.agentGui.toolSidebar.unavailable",
            { tool: i18n.t("workspace.agentGui.toolSidebar.tasks") }
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
  if (panel === "terminal") {
    return (
      <Suspense
        fallback={
          <StandaloneAgentToolLoadingState label={i18n.t("common.loading")} />
        }
      >
        <LazyStandaloneAgentTerminalPanel
          contributions={contributions}
          loadingLabel={i18n.t("common.loading")}
          open={active}
          setToolHost={setToolHost}
          unavailableLabel={i18n.t(
            "workspace.agentGui.toolSidebar.unavailable"
          )}
        />
      </Suspense>
    );
  }
  return null;
}
