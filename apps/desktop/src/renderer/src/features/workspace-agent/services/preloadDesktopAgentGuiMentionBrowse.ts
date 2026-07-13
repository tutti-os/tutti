import { preloadAgentMentionBrowse } from "@tutti-os/agent-gui/mention-search";
import type { AgentActivityRuntime } from "@tutti-os/agent-gui";
import {
  AGENT_CONTEXT_MENTION_PROVIDER_IDS,
  type AgentContextMentionProvider
} from "@tutti-os/agent-gui/context-mention-provider";
import { createDesktopAgentGeneratedFileMentionProvider } from "./internal/createDesktopAgentGeneratedFileMentionProvider.ts";
import { composeDesktopAgentGuiContextMentionProviders } from "./internal/composeDesktopAgentGuiContextMentionProviders.ts";

// Mirrors the composer's hardcoded currentUserId (DesktopAgentGUIWorkbenchBody),
// so the warmed browse cache key matches the live controller's.
const DESKTOP_AGENT_GUI_CURRENT_USER_ID = "local";

/**
 * Warm the @-mention browse cache at workspace startup, before the agent GUI is
 * ever opened, so the first palette open is instant. Builds the same effective
 * provider set as the live composer body — minus the dock-file wrapper, which
 * needs a workbench host that does not exist yet at startup. The provider id set
 * (hence the cache key) is identical, so the live controller reuses this warm;
 * dock-file enrichment and provider refreshes fill in on first open
 * via the 30s TTL revalidation. sessionCwd is "" because no agent session (and
 * therefore no selected project) exists yet at startup.
 */
export function preloadDesktopAgentGuiMentionBrowse(input: {
  workspaceId: string;
  baseProviders: readonly AgentContextMentionProvider[];
  agentActivityRuntime: AgentActivityRuntime;
}): void {
  const workspaceId = input.workspaceId.trim();
  if (!workspaceId) {
    return;
  }
  const workspaceAppBaseProvider =
    input.baseProviders.find(
      (provider) =>
        provider.id === AGENT_CONTEXT_MENTION_PROVIDER_IDS.workspaceApp
    ) ?? null;
  const contextMentionProviders = composeDesktopAgentGuiContextMentionProviders(
    {
      baseProviders: input.baseProviders,
      agentGeneratedFileMentionProvider:
        createDesktopAgentGeneratedFileMentionProvider({
          agentActivityRuntime: input.agentActivityRuntime,
          workspaceId
        }),
      workspaceAppMentionProvider: workspaceAppBaseProvider
    }
  );
  preloadAgentMentionBrowse({
    workspaceId,
    currentUserId: DESKTOP_AGENT_GUI_CURRENT_USER_ID,
    sessionCwd: "",
    contextMentionProviders
  });
}
