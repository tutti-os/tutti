import type { AgentSessionEngine } from "@tutti-os/agent-activity-core";
import { AgentGUIConversationRailQueryController as InternalAgentGUIConversationRailQueryController } from "./agent-gui/agentGuiNode/controller/AgentGUIConversationRailQueryController.ts";
import type { CachedConversationRailQuery } from "./agent-gui/agentGuiNode/controller/agentGuiConversationRailQueryCache.ts";
import type { AgentGUIConversationRailQuerySnapshot } from "./agent-gui/agentGuiNode/controller/agentConversationRailQuerySnapshot.ts";
import type { ConversationRailQueryScope } from "./agent-gui/agentGuiNode/controller/agentGuiConversationRailQueryTypes.ts";
import type { AgentConversationRailRuntimePort } from "./agentConversationRailContracts.ts";
import type { AgentGUIConversationActivityController } from "./agent-gui/agentGuiNode/controller/agentGUIConversationActivityController.ts";
import {
  createWorkspaceQueryCache,
  type WorkspaceQueryCache
} from "./shared/query/workspaceQueryCache.ts";

export type {
  AgentGUIConversationRailQuerySnapshot,
  ConversationRailQueryScope
};

export type ConversationRailQueryRuntime = Pick<
  AgentConversationRailRuntimePort,
  | "listPinnedSessionsPage"
  | "listSessionSectionPage"
  | "listSessionSections"
  | "listSessionsPage"
  | "reportDiagnostic"
>;

export interface AgentGUIConversationRailQueryControllerInput {
  engine: AgentSessionEngine;
  getActiveConversationId(): string | null;
  runtime: ConversationRailQueryRuntime;
  scheduler?: {
    schedule(
      delayMs: number,
      task: () => void
    ): {
      cancel(): void;
    };
  };
  sectionPageSize?: number;
  sectionRefreshLimitMax?: number;
  workspaceId: string;
}

export interface AgentGUIConversationRailQueryController {
  activityController: AgentGUIConversationActivityController;
  attach(): () => void;
  configure(scope: ConversationRailQueryScope): void;
  getSnapshot(): AgentGUIConversationRailQuerySnapshot;
  isInteractionLocked(): boolean;
  loadMoreSearchResults(): void;
  loadMoreSectionConversations(section: { id: string }): void;
  refresh(): Promise<void>;
  retrySearchResults(): void;
  setSearchQuery(value: string): void;
  subscribe(
    listener: (snapshot: AgentGUIConversationRailQuerySnapshot) => void
  ): () => void;
}

const conversationRailQueryCachesByEngine = new WeakMap<
  AgentSessionEngine,
  WorkspaceQueryCache<CachedConversationRailQuery>
>();

export function createAgentGUIConversationRailQueryController(
  input: AgentGUIConversationRailQueryControllerInput
): AgentGUIConversationRailQueryController {
  let sessionSectionsQueryCache = conversationRailQueryCachesByEngine.get(
    input.engine
  );
  if (!sessionSectionsQueryCache) {
    sessionSectionsQueryCache =
      createWorkspaceQueryCache<CachedConversationRailQuery>();
    conversationRailQueryCachesByEngine.set(
      input.engine,
      sessionSectionsQueryCache
    );
  }
  return new InternalAgentGUIConversationRailQueryController({
    ...input,
    sessionSectionsQueryCache
  });
}
