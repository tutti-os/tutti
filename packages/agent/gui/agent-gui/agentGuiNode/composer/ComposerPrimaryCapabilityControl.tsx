import { ConnectorComposerMenu } from "@tutti-os/connector-renderer/ui";
import { openWorkspaceSettingsPanel } from "../../../shared/workspaceSettingsPanel/workspaceSettingsPanelStore";
import { projectConnectorComposerItems } from "../integrations/connector/model/connectorPresentation";
import type { AgentComposerProps } from "./AgentComposer.types";
import { ComposerTuttiModeChip } from "./ComposerTuttiModeChip";

interface Props {
  availableSkills: AgentComposerProps["availableSkills"];
  connectorsVisible: boolean;
  connectorsReadOnly?: boolean;
  showConnectorViewMore?: boolean;
  disabled: boolean;
  isTuttiModeActive: boolean;
  isTuttiModeUpdating: boolean;
  labels: AgentComposerProps["labels"];
  loading: boolean;
  onRetryComposerOptions?: AgentComposerProps["onRetryComposerOptions"];
  onCapabilitySettingsRequest: AgentComposerProps["onCapabilitySettingsRequest"];
  onConnectorSelected: (connectorKey: string, selected: boolean) => void;
  onTuttiModeChange?: (active: boolean) => void;
  selectedConnectorKeys: readonly string[];
  tuttiModeSupported: boolean;
}

/**
 * Owns the host-gated capability controls between the mention and handoff
 * controls. Tutti Mode and Connectors are independent capabilities, so either
 * may render alone and both remain visible when both host gates are enabled.
 */
export function ComposerPrimaryCapabilityControl({
  availableSkills,
  connectorsVisible,
  connectorsReadOnly = false,
  disabled,
  isTuttiModeActive,
  isTuttiModeUpdating,
  labels,
  loading,
  onRetryComposerOptions,
  onCapabilitySettingsRequest,
  onConnectorSelected,
  onTuttiModeChange,
  selectedConnectorKeys,
  showConnectorViewMore = true,
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
    <>
      <ComposerTuttiModeChip
        active={isTuttiModeActive}
        updating={isTuttiModeUpdating}
        label={labels.tuttiModeLabel}
        description={labels.tuttiModeDescription}
        tuttiModeSupported={tuttiModeSupported}
        onTuttiModeChange={onTuttiModeChange}
      />
      <ConnectorComposerMenu
        disabled={disabled}
        items={projectConnectorComposerItems(
          availableSkills ?? [],
          connectorsReadOnly ? [] : selectedConnectorKeys
        )}
        labels={{
          authorize: labels.addContentConnectorAuthorize,
          connect: labels.addContentConnectorConnect,
          connected: labels.addContentConnectorConnected,
          connectors: labels.addContentConnectors,
          empty: labels.addContentConnectorEmpty,
          loading: labels.addContentConnectorLoading,
          more: labels.addContentConnectorMore,
          selected: labels.addContentConnectorSelected
        }}
        loading={loading}
        onInstallConnector={
          connectorsReadOnly || !onCapabilitySettingsRequest
            ? undefined
            : async (connectorKey) => {
                await onCapabilitySettingsRequest({
                  kind: "connector",
                  connectorKey,
                  action: "install"
                });
                onRetryComposerOptions?.({ section: "connectors" });
              }
        }
        onOpenChange={(open) => {
          if (open) {
            onRetryComposerOptions?.({ section: "connectors" });
          }
        }}
        onOpenConnector={
          connectorsReadOnly
            ? undefined
            : (connectorKey) =>
                onCapabilitySettingsRequest?.({
                  kind: "connector",
                  connectorKey,
                  action: "open"
                })
        }
        onOpenMarket={
          !showConnectorViewMore
            ? undefined
            : () =>
                openWorkspaceSettingsPanel({
                  section: "agent",
                  pane: "connectors"
                })
        }
        onRuntimeEnabledChange={
          connectorsReadOnly || !onCapabilitySettingsRequest
            ? undefined
            : (connectorKey, enabled) =>
                onCapabilitySettingsRequest({
                  kind: "connector",
                  connectorKey,
                  action: "set_runtime_enabled",
                  enabled
                })
        }
        onSelectConnector={connectorsReadOnly ? undefined : onConnectorSelected}
        readOnly={connectorsReadOnly}
      />
    </>
  );
}
