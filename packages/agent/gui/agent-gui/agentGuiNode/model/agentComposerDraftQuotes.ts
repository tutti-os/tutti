import type { AgentPromptContentBlock } from "../../../shared/contracts/dto";
import type {
  AgentComposerDraft,
  AgentComposerDraftContent,
  AgentComposerQuoteBlock,
  AgentComposerSupplementaryBlock
} from "./agentGuiNodeTypes";

export function agentComposerDraftQuotes(
  draft: AgentComposerDraftContent
): AgentComposerQuoteBlock[] {
  return draft
    .filter((block): block is AgentComposerQuoteBlock => block.type === "quote")
    .map((quote) => ({ ...quote }));
}

export function appendAgentComposerDraftQuote(
  draft: AgentComposerDraft,
  quote: AgentComposerQuoteBlock
): AgentComposerDraft {
  const text = quote.text.trim();
  if (
    !text ||
    agentComposerDraftQuotes(draft).some((item) => item.text === text)
  ) {
    return draft;
  }
  const supplementaryBlocks = draft.slice(
    1
  ) as AgentComposerSupplementaryBlock[];
  return [draft[0], ...supplementaryBlocks, { ...quote, text }];
}

export function agentComposerQuotePromptContent(
  quotes: readonly AgentComposerQuoteBlock[]
): AgentPromptContentBlock[] {
  return quotes.flatMap((quote) => {
    const text = quote.text.trim();
    if (!text) return [];
    return [
      {
        type: "text" as const,
        text: text
          .split(/\r?\n/u)
          .map((line) => `> ${line}`)
          .join("\n")
      }
    ];
  });
}
