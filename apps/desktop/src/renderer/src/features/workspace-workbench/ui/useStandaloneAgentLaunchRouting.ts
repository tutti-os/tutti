import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction
} from "react";
import type { WorkbenchHostNodeBodyContext } from "@tutti-os/workbench-surface";
import type { DesktopAgentDirectorySnapshot } from "@shared/contracts/agentDirectory.ts";
import type { DesktopHostWindowApi } from "@preload/types";
import type { IWorkspaceAppCenterService } from "@renderer/features/workspace-app-center";
import type { IAgentProviderStatusService as AgentProviderStatusService } from "@renderer/features/workspace-agent/services/agentProviderStatusService.interface.ts";
import type { IWorkspaceAgentActivityService } from "@renderer/features/workspace-agent/services/workspaceAgentActivityService.interface.ts";
import { runDesktopAgentGUILinkAction } from "@renderer/features/workspace-agent/services/desktopAgentGUILinkActions.ts";
import type { DesktopAgentGUIWorkbenchBodyProps } from "@renderer/features/workspace-agent/ui/desktopAgentGUIWorkbenchModel.ts";
import {
  registerWorkspaceAgentGuiLaunchHandler,
  requestWorkspaceAgentGuiLaunch
} from "@renderer/features/workspace-agent/services/workspaceAgentGuiLaunchCoordinator.ts";
import {
  desktopAgentGUIOpenSessionActivationType,
  normalizeDesktopAgentGUIProvider,
  type DesktopAgentGUIProvider,
  type DesktopAgentGUIWorkbenchState
} from "@renderer/features/workspace-agent/desktopAgentGUINodeState.ts";
import { handleStandaloneAgentGuiLaunch } from "../services/standaloneAgentGuiLaunchHandler.ts";
import type { StandaloneAgentIssueManagerOpenRequest } from "../services/standaloneAgentIssueManagerLaunch.ts";
import { createStandaloneAgentWorkspaceIssueManagerPresenter } from "../services/standaloneAgentWorkspaceIssueManagerPresenter.ts";
import {
  registerWorkspaceIssueManagerLaunchPresenter,
  requestWorkspaceIssueManagerLaunch
} from "../services/workspaceIssueManagerLaunchCoordinator.ts";

interface StandaloneAgentLaunchRoutingInput {
  agentDirectorySnapshot: DesktopAgentDirectorySnapshot;
  agentProviderStatusService: AgentProviderStatusService;
  headerProvider: DesktopAgentGUIProvider;
  homeDirectory: string;
  hostWindowApi: Pick<DesktopHostWindowApi, "openAgentWindow">;
  openFileInSidebar(
    path: string,
    validateExists?: boolean
  ): Promise<boolean> | boolean;
  setActivation: Dispatch<
    SetStateAction<WorkbenchHostNodeBodyContext["activation"]>
  >;
  setNodeState: Dispatch<SetStateAction<DesktopAgentGUIWorkbenchState>>;
  workspaceAgentActivityService: IWorkspaceAgentActivityService;
  workspaceAppCenterService: IWorkspaceAppCenterService;
  workspaceId: string;
}

export function useStandaloneAgentLaunchRouting({
  agentDirectorySnapshot,
  agentProviderStatusService,
  headerProvider,
  homeDirectory,
  hostWindowApi,
  openFileInSidebar,
  setActivation,
  setNodeState,
  workspaceAgentActivityService,
  workspaceAppCenterService,
  workspaceId
}: StandaloneAgentLaunchRoutingInput): {
  handleLinkAction: NonNullable<
    DesktopAgentGUIWorkbenchBodyProps["onLinkAction"]
  >;
  handleOpenMessageCenterChat(input: {
    agentSessionId: string;
    provider: string;
  }): void;
  issueManagerOpenRequest: StandaloneAgentIssueManagerOpenRequest | null;
} {
  const activationSequenceRef = useRef(1);
  const [issueManagerOpenRequest, setIssueManagerOpenRequest] =
    useState<StandaloneAgentIssueManagerOpenRequest | null>(null);
  const issueManagerPresenter = useMemo(
    () =>
      createStandaloneAgentWorkspaceIssueManagerPresenter({
        open: setIssueManagerOpenRequest
      }),
    []
  );
  const handleActivateAgentSession = useCallback(
    (input: {
      agentSessionId: string;
      agentTargetId: string | null;
      provider: string;
    }) => {
      setNodeState((current) => ({
        ...current,
        agentTargetId: input.agentTargetId,
        lastActiveAgentSessionId: input.agentSessionId,
        provider: normalizeDesktopAgentGUIProvider(input.provider)
      }));
      setActivation({
        payload: { agentSessionId: input.agentSessionId },
        sequence: ++activationSequenceRef.current,
        type: desktopAgentGUIOpenSessionActivationType
      });
    },
    [setActivation, setNodeState]
  );
  const handleOpenMessageCenterChat = useCallback(
    (input: { agentSessionId: string; provider: string }) => {
      handleActivateAgentSession({ ...input, agentTargetId: null });
    },
    [handleActivateAgentSession]
  );

  useEffect(
    () =>
      registerWorkspaceAgentGuiLaunchHandler(workspaceId, (request) =>
        handleStandaloneAgentGuiLaunch(request, {
          activateAgentSession: handleActivateAgentSession,
          agentDirectorySnapshot,
          headerProvider,
          openAgentWindow: (input) => hostWindowApi.openAgentWindow(input),
          providerStatusSnapshot: agentProviderStatusService.getSnapshot(),
          workspaceId
        })
      ),
    [
      agentDirectorySnapshot,
      agentProviderStatusService,
      handleActivateAgentSession,
      headerProvider,
      hostWindowApi,
      workspaceId
    ]
  );
  useEffect(
    () =>
      registerWorkspaceIssueManagerLaunchPresenter(
        workspaceId,
        issueManagerPresenter
      ),
    [issueManagerPresenter, workspaceId]
  );

  const handleLinkAction = useCallback<
    NonNullable<DesktopAgentGUIWorkbenchBodyProps["onLinkAction"]>
  >(
    (action) => {
      void runDesktopAgentGUILinkAction(action, {
        getAgentSession: ({ agentSessionId, workspaceId }) =>
          workspaceAgentActivityService.getSession(workspaceId, agentSessionId),
        homeDirectory,
        launchAgentGui: requestWorkspaceAgentGuiLaunch,
        launchWorkspaceIssueManager: requestWorkspaceIssueManagerLaunch,
        launchWorkspaceFiles: ({ path, validateExists }) =>
          openFileInSidebar(path, validateExists),
        launchWorkspaceApp: async ({
          appId,
          workspaceId: targetWorkspaceId
        }) => {
          await workspaceAppCenterService.openApp({
            appId,
            workspaceId: targetWorkspaceId
          });
          return true;
        },
        launchGroupChat: () => false,
        openBrowserUrl: () => false,
        workspaceId
      });
    },
    [
      homeDirectory,
      openFileInSidebar,
      workspaceAgentActivityService,
      workspaceAppCenterService,
      workspaceId
    ]
  );

  return {
    handleLinkAction,
    handleOpenMessageCenterChat,
    issueManagerOpenRequest
  };
}
