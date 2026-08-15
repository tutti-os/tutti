import { openWorkspaceSettingsPanel } from "../../../shared/workspaceSettingsPanel/workspaceSettingsPanelStore";
import type { AgentComposerProps } from "./AgentComposer.types";
import { ComposerConnectorsMenu } from "./ComposerConnectorsMenu";
import { ComposerTuttiModeChip } from "./ComposerTuttiModeChip";

interface Props {
  availableSkills: AgentComposerProps["availableSkills"];
  connectorsVisible: boolean;
  disabled: boolean;
  isTuttiModeActive: boolean;
  isTuttiModeUpdating: boolean;
  labels: AgentComposerProps["labels"];
  onRetryComposerOptions?: AgentComposerProps["onRetryComposerOptions"];
  onCapabilitySettingsRequest: AgentComposerProps["onCapabilitySettingsRequest"];
  onTuttiModeChange?: (active: boolean) => void;
  tuttiModeSupported: boolean;
}

/**
 * Owns the single primary capability slot between the mention and handoff
 * controls. Connector visibility is host-owned; when it is off, the slot
 * falls back to Tutti Mode instead of leaving an empty connector catalog.
 */
export function ComposerPrimaryCapabilityControl({
  availableSkills,
  connectorsVisible,
  disabled,
  isTuttiModeActive,
  isTuttiModeUpdating,
  labels,
  onRetryComposerOptions,
  onCapabilitySettingsRequest,
  onTuttiModeChange,
  tuttiModeSupported
}: Props): React.JSX.Element | null {
  if (!connectorsVisible) {
    return (
      <ComposerTuttiModeChip
        active={isTuttiModeActive}
        updating={isTuttiModeUpdating}
        label={labels.tuttiModeLabel}
        description={labels.tuttiModeDescription}
        tuttiModeSupported={tuttiModeSupported}
        onTuttiModeChange={onTuttiModeChange}
      />
    );
  }

  return (
    <ComposerConnectorsMenu
      connectors={availableSkills ?? []}
      disabled={disabled || !onCapabilitySettingsRequest}
      labels={{
        connectors: labels.addContentConnectors,
        connectorConnected: labels.addContentConnectorConnected,
        connectorConnect: labels.addContentConnectorConnect,
        connectorAuthorize: labels.addContentConnectorAuthorize,
        connectorEmpty: labels.addContentConnectorEmpty,
        connectorMore: labels.addContentConnectorMore
      }}
      onOpenChange={(open) => {
        if (open) {
          onRetryComposerOptions?.({ section: "capabilities" });
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
    />
  );
}
