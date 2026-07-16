import type { AgentActivityRuntime } from "@tutti-os/agent-gui";
import {
  AGENT_CONTEXT_MENTION_PROVIDER_IDS,
  type AgentContextMentionProvider
} from "@tutti-os/agent-gui/context-mention-provider";
import { createRichTextMarkdownLinkInsertResult } from "@tutti-os/ui-rich-text/plugins";
import type { ReferenceProvenanceFilter } from "@tutti-os/workspace-file-reference/contracts";
import {
  tuttiFileAssetUrls,
  tuttiFolderAssetUrls
} from "../../../../../../shared/tuttiAssetProtocol.ts";

const { agentGeneratedFile: AGENT_GENERATED_FILE_PROVIDER_ID } =
  AGENT_CONTEXT_MENTION_PROVIDER_IDS;

interface AgentGeneratedFileMentionItem {
  displayName: string;
  path: string;
}

export function createDesktopAgentGeneratedFileMentionProvider(input: {
  agentActivityRuntime: Pick<AgentActivityRuntime, "listAgentGeneratedFiles">;
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
      const sectionKey = metadataString(
        searchInput.context.metadata,
        "sectionKey",
        ""
      );
      if (!sectionKey || !input.agentActivityRuntime.listAgentGeneratedFiles) {
        return [];
      }
      const provenanceFilter = metadataReferenceProvenanceFilter(
        searchInput.context.metadata
      );
      const agentTargetIds = provenanceFilter?.agentTargetIds ?? null;
      if (agentTargetIds?.length === 0) return [];

      const result = await input.agentActivityRuntime.listAgentGeneratedFiles({
        agentTargetIds: agentTargetIds ?? undefined,
        limit: searchInput.maxResults,
        query: searchInput.keyword.trim(),
        sectionKey,
        signal: searchInput.abortSignal,
        workspaceId
      });
      if (searchInput.abortSignal?.aborted) {
        return [];
      }
      return result.entries.map((file) => ({
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
