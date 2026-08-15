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
  connectorMore: string;
}

interface Props {
  connectors: readonly AgentGUIProviderSkillOption[];
  disabled: boolean;
  labels: ComposerConnectorsMenuLabels;
  onOpenChange?: (open: boolean) => void;
  onOpenConnector: (connectorKey: string) => void;
  onOpenConnectors: () => void;
}

/** Maps AgentGUI composer capability options into Connector Market semantics. */
export function ComposerConnectorsMenu({
  connectors,
  disabled,
  labels,
  onOpenChange,
  onOpenConnector,
  onOpenConnectors
}: Props): React.JSX.Element {
  return (
    <ConnectorComposerMenu
      disabled={disabled}
      items={projectConnectorComposerItems(connectors)}
      labels={{
        authorize: labels.connectorAuthorize,
        connect: labels.connectorConnect,
        connected: labels.connectorConnected,
        connectors: labels.connectors,
        empty: labels.connectorEmpty,
        more: labels.connectorMore
      }}
      onOpenChange={onOpenChange}
      onOpenConnector={onOpenConnector}
      onOpenMarket={onOpenConnectors}
    />
  );
}

export function projectConnectorComposerItems(
  options: readonly AgentGUIProviderSkillOption[]
): ConnectorComposerItem[] {
  const items: ConnectorComposerItem[] = [];
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
