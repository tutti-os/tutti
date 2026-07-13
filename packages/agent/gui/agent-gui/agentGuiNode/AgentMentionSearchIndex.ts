import { resolveAgentMentionFileThumbnailUrl } from "../shared/mentionFilePresentation";
import type { AgentContextMentionItem } from "./agentRichText/agentFileMentionExtension";
import type { AgentContextMentionProvider } from "./agentContextMentionProvider";
import type { AgentMentionProviderQueryDiagnostic } from "./agentMentionSearchDiagnostics";
import {
  emptyAgentMentionRawGroups,
  normalizeSessionMentionItemsForMySessions,
  providerItemToAgentMentionItem,
  totalCountsFromRawGroups
} from "./AgentMentionSearchModel";
import type { AgentMentionFilterId } from "./AgentMentionSearchContracts";
import {
  AGENT_GENERATED_FILE_PROVIDER_ID,
  AGENT_SESSION_PROVIDER_ID,
  AGENT_TARGET_PROVIDER_ID,
  DEFAULT_SESSION_LIMIT,
  FILE_PROVIDER_ID,
  WORKSPACE_APP_PROVIDER_ID,
  WORKSPACE_ISSUE_PROVIDER_ID
} from "./AgentMentionSearchContracts";
import type { AgentMentionBrowseFetchResult } from "./AgentMentionSearchCache";

export interface AgentMentionProviderQueryInput {
  diagnostics: AgentMentionProviderQueryDiagnostic[];
  providerId: string;
  workspaceId: string;
  currentUserId: string;
  query: string;
  limit?: number;
  sessionCwd?: string;
}

export async function fetchAgentMentionFilterResult(input: {
  workspaceId: string;
  currentUserId: string;
  query: string;
  filter: AgentMentionFilterId;
  sessionCwd: string;
  includeAgentGeneratedFiles: boolean;
  fileLimit: number;
  currentFileSearchLimit: number;
  currentIssueSearchLimit: number;
  queryProviderMentionItemsById: (
    input: AgentMentionProviderQueryInput
  ) => Promise<AgentContextMentionItem[]>;
}): Promise<AgentMentionBrowseFetchResult> {
  const providerDiagnostics: AgentMentionProviderQueryDiagnostic[] = [];
  switch (input.filter) {
    case "file": {
      const fileQuery = input.queryProviderMentionItemsById({
        providerId: FILE_PROVIDER_ID,
        workspaceId: input.workspaceId,
        currentUserId: input.currentUserId,
        query: input.query,
        limit: input.query ? input.currentFileSearchLimit : input.fileLimit,
        sessionCwd: input.sessionCwd,
        diagnostics: providerDiagnostics
      });
      const agentGeneratedFileQuery = input.includeAgentGeneratedFiles
        ? input.queryProviderMentionItemsById({
            providerId: AGENT_GENERATED_FILE_PROVIDER_ID,
            workspaceId: input.workspaceId,
            currentUserId: input.currentUserId,
            query: input.query,
            limit: input.fileLimit,
            sessionCwd: input.sessionCwd,
            diagnostics: providerDiagnostics
          })
        : Promise.resolve([] as AgentContextMentionItem[]);
      const [fileItems, agentGeneratedFileItems] = await Promise.all([
        fileQuery,
        agentGeneratedFileQuery
      ]);
      const rawGroups = emptyAgentMentionRawGroups();
      rawGroups.opened_files = fileItems.filter((item) => item.kind === "file");
      rawGroups.agent_generated_files = agentGeneratedFileItems.filter(
        (item) => item.kind === "file"
      );
      return {
        providerDiagnostics,
        rawGroups,
        totalCounts: totalCountsFromRawGroups(rawGroups)
      };
    }
    case "session": {
      const sessionItems = await input.queryProviderMentionItemsById({
        providerId: AGENT_SESSION_PROVIDER_ID,
        workspaceId: input.workspaceId,
        currentUserId: input.currentUserId,
        query: input.query,
        limit: DEFAULT_SESSION_LIMIT,
        sessionCwd: input.sessionCwd,
        diagnostics: providerDiagnostics
      });
      const rawGroups = emptyAgentMentionRawGroups();
      rawGroups.my_sessions = normalizeSessionMentionItemsForMySessions({
        currentUserId: input.currentUserId,
        items: sessionItems
      });
      return {
        providerDiagnostics,
        rawGroups,
        totalCounts: totalCountsFromRawGroups(rawGroups)
      };
    }
    case "issue": {
      const issueItems = await input.queryProviderMentionItemsById({
        providerId: WORKSPACE_ISSUE_PROVIDER_ID,
        workspaceId: input.workspaceId,
        currentUserId: input.currentUserId,
        query: input.query,
        limit: input.currentIssueSearchLimit,
        sessionCwd: input.sessionCwd,
        diagnostics: providerDiagnostics
      });
      const rawGroups = emptyAgentMentionRawGroups();
      rawGroups.issues = issueItems.filter(
        (item) => item.kind === "workspace-issue"
      );
      return {
        providerDiagnostics,
        rawGroups,
        totalCounts: totalCountsFromRawGroups(rawGroups)
      };
    }
    case "agent": {
      const agentItems = await input.queryProviderMentionItemsById({
        providerId: AGENT_TARGET_PROVIDER_ID,
        workspaceId: input.workspaceId,
        currentUserId: input.currentUserId,
        query: input.query,
        sessionCwd: input.sessionCwd,
        diagnostics: providerDiagnostics
      });
      const rawGroups = emptyAgentMentionRawGroups();
      rawGroups.agents = agentItems.filter(
        (item) => item.kind === "agent-target"
      );
      return {
        providerDiagnostics,
        rawGroups,
        totalCounts: totalCountsFromRawGroups(rawGroups)
      };
    }
    case "app": {
      const appItems = await input.queryProviderMentionItemsById({
        providerId: WORKSPACE_APP_PROVIDER_ID,
        workspaceId: input.workspaceId,
        currentUserId: input.currentUserId,
        query: input.query,
        sessionCwd: input.sessionCwd,
        diagnostics: providerDiagnostics
      });
      const rawGroups = emptyAgentMentionRawGroups();
      rawGroups.apps = appItems.filter((item) => item.kind === "workspace-app");
      return {
        providerDiagnostics,
        rawGroups,
        totalCounts: totalCountsFromRawGroups(rawGroups)
      };
    }
  }
}

export async function queryAgentMentionProviderItems(input: {
  provider: AgentContextMentionProvider;
  workspaceId: string;
  currentUserId: string;
  query: string;
  limit?: number;
  sessionCwd: string;
  abortSignal: AbortSignal;
}): Promise<AgentContextMentionItem[]> {
  const items = await input.provider.query({
    keyword: input.query,
    maxResults: input.limit,
    abortSignal: input.abortSignal,
    trigger: "@",
    context: {
      metadata: {
        currentUserId: input.currentUserId,
        sessionCwd: input.sessionCwd || undefined,
        target: "agent-gui",
        workspaceId: input.workspaceId
      }
    }
  });
  if (input.abortSignal.aborted) {
    return [];
  }
  const mentionItems = await Promise.all(
    items.map(async (item) => {
      const mentionItem = providerItemToAgentMentionItem({
        currentUserId: input.currentUserId,
        insertResult: input.provider.toInsertResult(item),
        label: input.provider.getItemLabel(item),
        providerId: input.provider.id,
        subtitle: input.provider.getItemSubtitle?.(item) ?? "",
        workspaceId: input.workspaceId
      });
      if (!mentionItem || mentionItem.kind !== "file") {
        return mentionItem;
      }
      const iconUrl = await Promise.resolve(
        input.provider.getItemIconUrl?.(item) ?? null
      ).catch(() => null);
      const resolvedThumbnailUrl = resolveAgentMentionFileThumbnailUrl({
        ...mentionItem,
        thumbnailUrl: iconUrl
      });
      if (!resolvedThumbnailUrl) {
        return mentionItem;
      }
      return {
        ...mentionItem,
        thumbnailUrl: resolvedThumbnailUrl
      };
    })
  );
  return mentionItems.filter(
    (item): item is AgentContextMentionItem => item !== null
  );
}
