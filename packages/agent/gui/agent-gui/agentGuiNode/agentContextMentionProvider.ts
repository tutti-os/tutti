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

export type AgentContextMentionInsertResult = RichTextTriggerInsertResult;

export type AgentContextMentionProvider<TItem = any> = Omit<
  RichTextTriggerProvider<TItem>,
  "trigger"
> & {
  trigger: "@";
};
