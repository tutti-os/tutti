import type { AgentPromptContentBlock } from "../../../shared/contracts/dto";
import type {
  AgentComposerDraft,
  AgentComposerDraftConnector,
  AgentComposerDraftContent
} from "./agentGuiNodeTypes";

export function agentComposerDraftConnectors(
  draft: AgentComposerDraftContent
): AgentComposerDraftConnector[] {
  return draft
    .filter(
      (
        block
      ): block is Extract<
        AgentComposerDraftContent[number],
        { type: "connector" }
      > => block.type === "connector"
    )
    .map(({ type: _type, ...connector }) => connector);
}

export function agentComposerDraftConnectorBlocks(
  connectors: readonly AgentComposerDraftConnector[]
): Extract<AgentComposerDraftContent[number], { type: "connector" }>[] {
  return connectors.map((connector) => ({
    type: "connector",
    connectorKey: connector.connectorKey
  }));
}

export function agentPromptContentConnectors(
  content: readonly AgentPromptContentBlock[]
): AgentComposerDraftConnector[] {
  return content.flatMap((block) => {
    if (block.type !== "connector") {
      return [];
    }
    const connectorKey = block.connectorKey?.trim();
    return connectorKey ? [{ connectorKey }] : [];
  });
}

export function mergeAgentComposerDraftConnectorKeys(
  draft: AgentComposerDraftContent,
  additionalKeys: readonly string[]
): string[] {
  return Array.from(
    new Set([
      ...agentComposerDraftConnectors(draft).map(
        (connector) => connector.connectorKey
      ),
      ...additionalKeys
    ])
  );
}

export function agentComposerDraftPreservingConnectors(
  previous: AgentComposerDraft | undefined
): AgentComposerDraft {
  return [
    { type: "text", text: "" },
    ...agentComposerDraftConnectorBlocks(
      previous ? agentComposerDraftConnectors(previous) : []
    )
  ];
}
