import { useCallback, useEffect, useMemo } from "react";
import { useSnapshot } from "valtio";
import type { AgentActivityRuntime } from "@tutti-os/agent-gui";
import {
  AGENT_CONTEXT_MENTION_PROVIDER_IDS,
  type AgentContextMentionProvider
} from "@tutti-os/agent-gui/context-mention-provider";
import { createRichTextMentionService } from "@tutti-os/ui-rich-text/service";
import type { IWorkspaceAppCenterService } from "@renderer/features/workspace-app-center";
import type {
  WorkbenchDockPreviewCache,
  WorkbenchHostNodeBodyContext
} from "@tutti-os/workbench-surface";
import { resolveWorkbenchDockFileMentionItems } from "../services/internal/resolveWorkbenchDockFileMentionItems.ts";
import { createDesktopAgentGeneratedFileMentionProvider } from "../services/internal/createDesktopAgentGeneratedFileMentionProvider.ts";
import { composeDesktopAgentGuiContextMentionProviders } from "../services/internal/composeDesktopAgentGuiContextMentionProviders.ts";
import { resolveDesktopWorkspaceAppIconEntries } from "../services/internal/desktopWorkspaceAppIcons.ts";
import { wrapDesktopFileMentionProviderWithDockFiles } from "../services/internal/wrapDesktopFileMentionProviderWithDockFiles.ts";
import { DESKTOP_AGENT_GUI_EMPTY_CONTEXT_MENTION_PROVIDERS } from "./desktopAgentGUIWorkbenchModel.ts";

export function useDesktopAgentGUIContextMentions(input: {
  agentActivityRuntime: AgentActivityRuntime;
  appCenterService: IWorkspaceAppCenterService;
  contextMentionProviders: readonly AgentContextMentionProvider[];
  dockPreviewCache: WorkbenchDockPreviewCache;
  host: WorkbenchHostNodeBodyContext["host"];
  workspaceId: string;
}) {
  const {
    agentActivityRuntime,
    appCenterService,
    contextMentionProviders,
    dockPreviewCache,
    host,
    workspaceId
  } = input;
  const appCenterState = useSnapshot(appCenterService.store);
  const workspaceAppIcons = useMemo(
    () =>
      resolveDesktopWorkspaceAppIconEntries({
        apps: appCenterState.apps,
        workspaceId
      }),
    [appCenterState.apps, workspaceId]
  );
  const workspaceAppMentionProvider = useMemo(() => {
    return (
      contextMentionProviders.find(
        (provider) =>
          provider.id === AGENT_CONTEXT_MENTION_PROVIDER_IDS.workspaceApp
      ) ?? null
    );
  }, [contextMentionProviders]);
  const agentGeneratedFileMentionProvider = useMemo(
    () =>
      createDesktopAgentGeneratedFileMentionProvider({
        agentActivityRuntime,
        workspaceId
      }),
    [agentActivityRuntime, workspaceId]
  );
  const resolveDockFiles = useCallback(
    () => resolveWorkbenchDockFileMentionItems({ host, workspaceId }),
    [host, workspaceId]
  );
  const effectiveContextMentionProviders = useMemo(() => {
    if (!agentGeneratedFileMentionProvider) {
      return DESKTOP_AGENT_GUI_EMPTY_CONTEXT_MENTION_PROVIDERS;
    }
    return composeDesktopAgentGuiContextMentionProviders({
      baseProviders: contextMentionProviders,
      agentGeneratedFileMentionProvider,
      workspaceAppMentionProvider,
      wrapBaseProvider: (provider) =>
        wrapDesktopFileMentionProviderWithDockFiles(provider, {
          readDockPreview: dockPreviewCache.read.bind(dockPreviewCache),
          resolveDockFiles
        })
    });
  }, [
    agentGeneratedFileMentionProvider,
    dockPreviewCache,
    resolveDockFiles,
    contextMentionProviders,
    workspaceAppMentionProvider
  ]);
  const mentionService = useMemo(
    () =>
      createRichTextMentionService({
        providers: effectiveContextMentionProviders
      }),
    [effectiveContextMentionProviders]
  );
  useEffect(() => () => mentionService.dispose(), [mentionService]);
  return {
    effectiveContextMentionProviders,
    mentionService,
    workspaceAppIcons
  };
}
