import { openWorkspaceSettingsPanel } from "../../../shared/workspaceSettingsPanel/workspaceSettingsPanelStore";
import type { AgentComposerProps } from "./AgentComposer.types";
import { ComposerConnectorsMenu } from "./ComposerConnectorsMenu";

interface Props {
  availableSkills: AgentComposerProps["availableSkills"];
  connectorsVisible: boolean;
  disabled: boolean;
  labels: AgentComposerProps["labels"];
  loading: boolean;
  onRetryComposerOptions?: AgentComposerProps["onRetryComposerOptions"];
  onCapabilitySettingsRequest: AgentComposerProps["onCapabilitySettingsRequest"];
  onConnectorSelected: (connectorKey: string, selected: boolean) => void;
  selectedConnectorKeys: readonly string[];
}

/**
 * Owns the single primary capability slot between the mention and handoff
 * controls. Connector visibility is host-owned; when it is off, the slot is
 * omitted. Tutti Mode remains available through slash commands.
 */
export function ComposerPrimaryCapabilityControl({
  availableSkills,
  connectorsVisible,
  disabled,
  labels,
  loading,
  onRetryComposerOptions,
  onCapabilitySettingsRequest,
  onConnectorSelected,
  selectedConnectorKeys
}: Props): React.JSX.Element | null {
  if (!connectorsVisible) {
    return null;
  }

  return (
    <ComposerConnectorsMenu
      connectors={availableSkills ?? []}
      disabled={disabled}
      labels={{
        connectors: labels.addContentConnectors,
        connectorConnected: labels.addContentConnectorConnected,
        connectorConnect: labels.addContentConnectorConnect,
        connectorAuthorize: labels.addContentConnectorAuthorize,
        connectorEmpty: labels.addContentConnectorEmpty,
        connectorLoading: labels.addContentConnectorLoading,
        connectorMore: labels.addContentConnectorMore,
        connectorSelected: labels.addContentConnectorSelected
      }}
      loading={loading}
      onOpenChange={(open) => {
        if (open) {
          onRetryComposerOptions?.({ section: "connectors" });
        }
      }}
      onOpenConnector={(connectorKey) =>
        onCapabilitySettingsRequest?.({
          kind: "connector",
          connectorKey,
          action: "open"
        })
      }
      onOpenConnectors={() =>
        openWorkspaceSettingsPanel({
          section: "agent",
          pane: "connectors"
        })
      }
      onSelectConnector={onConnectorSelected}
      selectedConnectorKeys={selectedConnectorKeys}
    />
  );
}
