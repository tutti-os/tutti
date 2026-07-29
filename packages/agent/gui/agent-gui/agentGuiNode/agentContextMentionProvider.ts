import type {
  RichTextTriggerInsertResult,
  RichTextTriggerProvider,
  RichTextTriggerQueryInput
} from "@tutti-os/ui-rich-text/types";
import {
  TUTTI_EXTERNAL_AT_PROVIDER_IDS,
  type TuttiExternalAtProviderId
} from "@tutti-os/workspace-external-core/contracts";

export const AGENT_CONTEXT_MENTION_PROVIDER_IDS =
  TUTTI_EXTERNAL_AT_PROVIDER_IDS;

export type AgentContextMentionProviderId = TuttiExternalAtProviderId;

export type AgentContextMentionQueryInput = RichTextTriggerQueryInput & {
  trigger: "@";
};

export interface AgentContextMentionDirectoryDescriptor {
  /** Canonical provider-owned directory path used for child queries. */
  path: string;
  /** Number of direct children when the provider can determine it. */
  childCount?: number | null;
}

export type AgentContextMentionDirectoryQueryInput =
  AgentContextMentionQueryInput & {
    directoryPath: string;
  };

export type AgentContextMentionInsertResult = RichTextTriggerInsertResult;

export type AgentContextMentionProvider<TItem = any> = Omit<
  RichTextTriggerProvider<TItem>,
  "trigger"
> & {
  trigger: "@";
  /** Optional hierarchy contract for file providers. */
  getItemDirectory?(
    item: TItem
  ): AgentContextMentionDirectoryDescriptor | null | undefined;
  /** Lists the direct children of one directory without overloading keyword search. */
  queryDirectory?(
    input: AgentContextMentionDirectoryQueryInput
  ): Promise<readonly TItem[]> | readonly TItem[];
};
