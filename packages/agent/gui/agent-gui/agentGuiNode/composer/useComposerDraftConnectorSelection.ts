import { useCallback } from "react";
import type { AgentComposerDraft } from "../model/agentGuiNodeTypes";
import {
  agentComposerDraftConnectors,
  updateAgentComposerDraft
} from "../model/agentComposerDraft";

type UpdateScopedDraft = (
  sourceScopeKey: string,
  update: (current: AgentComposerDraft) => AgentComposerDraft
) => AgentComposerDraft | null;

export function useDraftConnectorSelection(
  draftScopeKey: string,
  updateScopedDraft: UpdateScopedDraft
) {
  const removeDraftConnector = useCallback(
    (connectorKey: string): void => {
      updateScopedDraft(draftScopeKey, (currentDraft) =>
        updateAgentComposerDraft(currentDraft, {
          connectors: agentComposerDraftConnectors(currentDraft).filter(
            (connector) => connector.connectorKey !== connectorKey
          )
        })
      );
    },
    [draftScopeKey, updateScopedDraft]
  );

  const setDraftConnectorSelected = useCallback(
    (connectorKey: string, selected: boolean): void => {
      const normalizedConnectorKey = connectorKey.trim();
      if (!normalizedConnectorKey) {
        return;
      }
      updateScopedDraft(draftScopeKey, (currentDraft) => {
        const connectors = agentComposerDraftConnectors(currentDraft);
        const alreadySelected = connectors.some(
          (connector) => connector.connectorKey === normalizedConnectorKey
        );
        if (alreadySelected === selected) {
          return currentDraft;
        }
        return updateAgentComposerDraft(currentDraft, {
          connectors: selected
            ? [...connectors, { connectorKey: normalizedConnectorKey }]
            : connectors.filter(
                (connector) => connector.connectorKey !== normalizedConnectorKey
              )
        });
      });
    },
    [draftScopeKey, updateScopedDraft]
  );

  return { removeDraftConnector, setDraftConnectorSelected };
}
