import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState
} from "react";
import { useWorkspaceCatalogService } from "@renderer/features/workspace-catalog";
import { useTranslation } from "@renderer/i18n";
import type { WorkspaceWorkbenchHostSessionBinding } from "../services/workspaceWorkbenchHostService.interface.ts";
import {
  StandaloneAgentWindow,
  type StandaloneAgentWindowProps
} from "./StandaloneAgentWindow.tsx";
import { useWorkspaceWorkbenchHostService } from "./useWorkspaceWorkbenchHostService.ts";
import { useWorkspaceWorkbenchShellRuntime } from "./useWorkspaceWorkbenchShellRuntime.tsx";
import { WorkspaceCloseGuardDialog } from "./WorkspaceCloseGuardDialog.tsx";
import { WorkspaceFallbackState } from "./WorkspaceFallbackState.tsx";

export interface StandaloneAgentWorkbenchProps extends Omit<
  StandaloneAgentWindowProps,
  "toolWorkbench" | "workspace"
> {
  enableWindowCloseGuard: boolean;
  workspaceID: string | null;
}

export function StandaloneAgentWorkbench({
  enableWindowCloseGuard,
  workspaceID,
  ...agentWindowInput
}: StandaloneAgentWorkbenchProps) {
  const { service, state } = useWorkspaceCatalogService();
  const { t } = useTranslation();
  const loadWorkspaceWindow = useCallback(() => {
    void service.loadWorkspaceWindow(workspaceID, "agent");
  }, [service, workspaceID]);

  useEffect(() => {
    loadWorkspaceWindow();
  }, [loadWorkspaceWindow]);

  if (state.status === "unavailable") {
    return (
      <WorkspaceFallbackState
        description={
          state.workspaceError ?? t("workspace.fallback.loadingDescription")
        }
        onRetry={loadWorkspaceWindow}
        title={t("workspace.fallback.unavailableTitle")}
        tone="destructive"
      />
    );
  }

  if (state.status === "loading" || !state.workspace) {
    return <main className="h-screen min-h-0 bg-background" />;
  }

  return (
    <StandaloneAgentWindowWithSession
      {...agentWindowInput}
      enableWindowCloseGuard={enableWindowCloseGuard}
      platform={state.platform}
      workspace={state.workspace}
    />
  );
}

function StandaloneAgentWindowWithSession(
  props: Omit<StandaloneAgentWindowProps, "toolWorkbench"> & {
    enableWindowCloseGuard: boolean;
    platform: NodeJS.Platform;
  }
) {
  const workbenchHostService = useWorkspaceWorkbenchHostService();
  const [hostSession, setHostSession] =
    useState<WorkspaceWorkbenchHostSessionBinding | null>(null);

  useLayoutEffect(() => {
    const binding = workbenchHostService.openHostSession(props.workspace.id);
    setHostSession(binding);
    return () => {
      binding.release();
    };
  }, [props.workspace.id, workbenchHostService]);

  if (
    !hostSession ||
    !hostSession.isActive ||
    hostSession.workspaceId !== props.workspace.id
  ) {
    return <main className="h-screen min-h-0 bg-background" />;
  }

  return (
    <StandaloneAgentWindowWithToolRuntime
      {...props}
      hostSession={hostSession}
    />
  );
}

function StandaloneAgentWindowWithToolRuntime({
  enableWindowCloseGuard,
  hostSession,
  platform,
  ...props
}: Omit<StandaloneAgentWindowProps, "toolWorkbench"> & {
  enableWindowCloseGuard: boolean;
  hostSession: WorkspaceWorkbenchHostSessionBinding;
  platform: NodeJS.Platform;
}) {
  const runtime = useWorkspaceWorkbenchShellRuntime({
    enableWindowCloseGuard,
    hostSession,
    state: {
      platform,
      workspace: props.workspace
    }
  });
  const toolWorkbench = useMemo(
    () => ({
      appI18n: runtime.appI18n,
      contributions: runtime.hostInput.contributions,
      onHostReady: runtime.onWorkbenchCloseGuardHostReady,
      requestWindowClose: runtime.requestWindowClose
    }),
    [
      runtime.appI18n,
      runtime.hostInput.contributions,
      runtime.onWorkbenchCloseGuardHostReady,
      runtime.requestWindowClose
    ]
  );

  return (
    <>
      <StandaloneAgentWindow {...props} toolWorkbench={toolWorkbench} />
      <WorkspaceCloseGuardDialog
        request={runtime.closeDialog.request}
        onCancel={runtime.closeDialog.onCancel}
        onConfirm={runtime.closeDialog.onConfirm}
      />
    </>
  );
}
