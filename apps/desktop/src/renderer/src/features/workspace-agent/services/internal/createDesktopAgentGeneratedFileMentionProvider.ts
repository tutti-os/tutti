import type { AgentActivityRuntime } from "@tutti-os/agent-gui";
import {
  selectCanonicalAgentActivitySessions,
  type AgentActivitySession
} from "@tutti-os/agent-activity-core";
import {
  AGENT_CONTEXT_MENTION_PROVIDER_IDS,
  type AgentContextMentionProvider
} from "@tutti-os/agent-gui/context-mention-provider";
import { collectWorkspaceAgentGeneratedFiles } from "@tutti-os/agent-gui/workspace-agent-generated-files";
import { createRichTextMarkdownLinkInsertResult } from "@tutti-os/ui-rich-text/plugins";
import type { ReferenceProvenanceFilter } from "@tutti-os/workspace-file-reference/contracts";
import {
  tuttiFileAssetUrls,
  tuttiFolderAssetUrls
} from "../../../../../../shared/tuttiAssetProtocol.ts";

const { agentGeneratedFile: AGENT_GENERATED_FILE_PROVIDER_ID } =
  AGENT_CONTEXT_MENTION_PROVIDER_IDS;

const DEFAULT_SESSION_MESSAGE_PAGE_SIZE = 200;

interface AgentGeneratedFileMentionItem {
  displayName: string;
  path: string;
}

export function createDesktopAgentGeneratedFileMentionProvider(input: {
  agentActivityRuntime: Pick<
    AgentActivityRuntime,
    "getSnapshot" | "listAgentGeneratedFiles" | "listSessionMessages"
  >;
  workspaceId: string;
}): AgentContextMentionProvider<AgentGeneratedFileMentionItem> {
  return {
    id: AGENT_GENERATED_FILE_PROVIDER_ID,
    trigger: "@",
    async query(searchInput) {
      if (searchInput.abortSignal?.aborted) {
        return [];
      }
      const workspaceId = metadataString(
        searchInput.context.metadata,
        "workspaceId",
        input.workspaceId
      );
      const sessionCwd = metadataString(
        searchInput.context.metadata,
        "sessionCwd",
        ""
      );
      const keyword = searchInput.keyword.trim();
      const provenanceFilter = metadataReferenceProvenanceFilter(
        searchInput.context.metadata
      );
      const agentTargetIds = provenanceFilter?.agentTargetIds ?? null;
      if (agentTargetIds?.length === 0) return [];
      if (input.agentActivityRuntime.listAgentGeneratedFiles) {
        const result = await input.agentActivityRuntime.listAgentGeneratedFiles(
          {
            agentTargetIds: agentTargetIds ?? undefined,
            limit: searchInput.maxResults,
            query: keyword,
            sessionCwd: sessionCwd || undefined,
            signal: searchInput.abortSignal,
            workspaceId
          }
        );
        if (searchInput.abortSignal?.aborted) {
          return [];
        }
        return result.entries.map((file) => ({
          displayName: file.label,
          path: file.path
        }));
      }
      const snapshot = input.agentActivityRuntime.getSnapshot(workspaceId);
      await hydrateRecentSessionMessages({
        abortSignal: searchInput.abortSignal,
        agentActivityRuntime: input.agentActivityRuntime,
        agentTargetIds,
        snapshot,
        workspaceId
      });
      if (searchInput.abortSignal?.aborted) {
        return [];
      }
      const refreshedSnapshot =
        input.agentActivityRuntime.getSnapshot(workspaceId);
      const files = collectWorkspaceAgentGeneratedFiles(refreshedSnapshot, {
        ...(agentTargetIds ? { agentTargetIds } : {}),
        ...(sessionCwd ? { sessionCwd } : {})
      });
      const normalizedKeyword = keyword.toLowerCase();
      const filtered = normalizedKeyword
        ? files.filter((file) =>
            matchesAgentGeneratedFileKeyword(file, normalizedKeyword)
          )
        : files;
      const limited =
        searchInput.maxResults && searchInput.maxResults > 0
          ? filtered.slice(0, searchInput.maxResults)
          : filtered;
      return limited.map((file) => ({
        displayName: file.label,
        path: file.path
      }));
    },
    getItemKey: (item) => item.path,
    getItemLabel: (item) => item.displayName,
    getItemSubtitle: (item) => item.path,
    getItemIconUrl: (item) =>
      item.path.endsWith("/")
        ? tuttiFolderAssetUrls.default
        : tuttiFileAssetUrls.default,
    toInsertResult(item) {
      return createRichTextMarkdownLinkInsertResult(
        item.displayName,
        item.path
      );
    }
  };
}

async function hydrateRecentSessionMessages(input: {
  abortSignal?: AbortSignal;
  agentActivityRuntime: Pick<AgentActivityRuntime, "listSessionMessages">;
  agentTargetIds: readonly string[] | null;
  snapshot: ReturnType<AgentActivityRuntime["getSnapshot"]>;
  workspaceId: string;
}): Promise<void> {
  const sessionsNeedingMessages = selectCanonicalAgentActivitySessions(
    input.snapshot
  ).filter((session) => {
    if (
      input.agentTargetIds !== null &&
      (session.agentTargetId === null ||
        !input.agentTargetIds.includes(session.agentTargetId))
    ) {
      return false;
    }
    const sessionId = session.agentSessionId.trim();
    if (!sessionId) {
      return false;
    }
    return shouldRefreshSessionMessages(
      session,
      input.snapshot.sessionMessagesById[sessionId] ?? []
    );
  });

  if (sessionsNeedingMessages.length === 0) {
    return;
  }

  await Promise.all(
    sessionsNeedingMessages.map(async (session) => {
      if (input.abortSignal?.aborted) {
        return;
      }
      await input.agentActivityRuntime
        .listSessionMessages({
          workspaceId: input.workspaceId,
          agentSessionId: session.agentSessionId,
          limit: DEFAULT_SESSION_MESSAGE_PAGE_SIZE,
          signal: input.abortSignal
        })
        .catch(() => undefined);
    })
  );
}

function metadataReferenceProvenanceFilter(
  metadata: Readonly<Record<string, unknown>> | undefined
): ReferenceProvenanceFilter | null {
  const value = metadata?.referenceProvenanceFilter;
  if (!value || typeof value !== "object") return null;
  const filter = value as Partial<ReferenceProvenanceFilter>;
  return {
    agentTargetIds: stringArrayOrNull(filter.agentTargetIds),
    memberIds: stringArrayOrNull(filter.memberIds)
  };
}

function stringArrayOrNull(value: unknown): readonly string[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) return null;
  return Array.from(
    new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
    )
  );
}

function shouldRefreshSessionMessages(
  session: AgentActivitySession,
  messages: ReturnType<
    AgentActivityRuntime["getSnapshot"]
  >["sessionMessagesById"][string]
): boolean {
  if (!messages || messages.length === 0) {
    return true;
  }
  const lastMessageAt = Math.max(
    0,
    ...messages.map(
      (message) =>
        message.occurredAtUnixMs ??
        message.completedAtUnixMs ??
        message.startedAtUnixMs ??
        0
    )
  );
  const sessionUpdatedAt =
    session.updatedAtUnixMs ?? session.lastEventUnixMs ?? 0;
  return sessionUpdatedAt > lastMessageAt;
}

function matchesAgentGeneratedFileKeyword(
  file: { label: string; path: string },
  keyword: string
): boolean {
  const haystack = `${file.label}\n${file.path}`.toLowerCase();
  return keyword
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => haystack.includes(token));
}

function metadataString(
  metadata: Readonly<Record<string, unknown>> | undefined,
  key: string,
  fallback: string
): string {
  const value = metadata?.[key];
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return fallback;
}
