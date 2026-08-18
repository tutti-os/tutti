import {
  ConnectorComposerMenu,
  type ConnectorComposerItem
} from "@tutti-os/connector-market/ui";
import type { AgentGUIProviderSkillOption } from "../model/agentGuiNodeTypes";

export interface ComposerConnectorsMenuLabels {
  connectors: string;
  connectorConnected: string;
  connectorConnect: string;
  connectorAuthorize: string;
  connectorEmpty: string;
  connectorLoading: string;
  connectorMore: string;
  connectorSelected: string;
}

interface Props {
  connectors: readonly AgentGUIProviderSkillOption[];
  disabled: boolean;
  labels: ComposerConnectorsMenuLabels;
  loading?: boolean;
  onOpenChange?: (open: boolean) => void;
  onOpenConnector: (connectorKey: string) => void;
  onOpenConnectors: () => void;
  onSelectConnector?: (connectorKey: string, selected: boolean) => void;
  selectedConnectorKeys?: readonly string[];
}

/** Maps AgentGUI composer capability options into Connector Market semantics. */
export function ComposerConnectorsMenu({
  connectors,
  disabled,
  labels,
  loading = false,
  onOpenChange,
  onOpenConnector,
  onOpenConnectors,
  onSelectConnector,
  selectedConnectorKeys = []
}: Props): React.JSX.Element {
  return (
    <ConnectorComposerMenu
      disabled={disabled}
      items={projectConnectorComposerItems(connectors, selectedConnectorKeys)}
      labels={{
        authorize: labels.connectorAuthorize,
        connect: labels.connectorConnect,
        connected: labels.connectorConnected,
        connectors: labels.connectors,
        empty: labels.connectorEmpty,
        loading: labels.connectorLoading,
        more: labels.connectorMore,
        selected: labels.connectorSelected
      }}
      loading={loading}
      onOpenChange={onOpenChange}
      onOpenConnector={onOpenConnector}
      onOpenMarket={onOpenConnectors}
      onSelectConnector={onSelectConnector}
    />
  );
}

export function projectConnectorComposerItems(
  options: readonly AgentGUIProviderSkillOption[],
  selectedConnectorKeys: readonly string[] = []
): ConnectorComposerItem[] {
  const items: ConnectorComposerItem[] = [];
  const selectedKeys = new Set(
    selectedConnectorKeys
      .map((connectorKey) => connectorKey.trim())
      .filter(Boolean)
  );
  for (const option of options) {
    if (option.sourceKind !== "connector" && option.kind !== "connector") {
      continue;
    }
    const connectorKey = option.connectorKey?.trim() ?? "";
    if (!connectorKey) {
      continue;
    }
    items.push({
      connectorKey,
      iconUrl: option.iconUrl,
      name: option.name,
      selected: selectedKeys.has(connectorKey),
      status:
        option.status === "available"
          ? "connected"
          : option.status === "authRequired"
            ? "authorization_required"
            : "setup_required"
    });
  }
  return items;
}
