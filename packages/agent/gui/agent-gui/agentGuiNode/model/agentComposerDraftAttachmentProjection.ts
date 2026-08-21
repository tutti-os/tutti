import type {
  AgentComposerDraftConnector,
  AgentComposerDraftContent,
  AgentComposerDraftFile,
  AgentComposerDraftImage,
  AgentComposerDraftLargeText,
  AgentComposerQuoteBlock
} from "./agentGuiNodeTypes";
import {
  agentComposerDraftFiles,
  agentComposerDraftImages,
  agentComposerDraftLargeTexts
} from "./agentComposerDraft";
import { agentComposerDraftConnectors } from "./agentComposerDraftConnectors";
import { agentComposerDraftQuotes } from "./agentComposerDraftQuotes";

interface AgentComposerDraftAttachmentProjection {
  images: AgentComposerDraftImage[];
  files: AgentComposerDraftFile[];
  largeTexts: AgentComposerDraftLargeText[];
  quotes: AgentComposerQuoteBlock[];
  connectors: AgentComposerDraftConnector[];
}

const projectionByDraft = new WeakMap<
  AgentComposerDraftContent,
  AgentComposerDraftAttachmentProjection
>();

export function agentComposerDraftAttachmentProjection(
  draft: AgentComposerDraftContent
): AgentComposerDraftAttachmentProjection {
  const cached = projectionByDraft.get(draft);
  if (cached) return cached;
  const projection = {
    images: agentComposerDraftImages(draft),
    files: agentComposerDraftFiles(draft),
    largeTexts: agentComposerDraftLargeTexts(draft),
    quotes: agentComposerDraftQuotes(draft),
    connectors: agentComposerDraftConnectors(draft)
  };
  projectionByDraft.set(draft, projection);
  return projection;
}
