import type {
  ConnectorComposerItem,
  ConnectorPaletteItemModel,
  ConnectorSelectionItem
} from "@tutti-os/connector-renderer/ui";
import type {
  AgentComposerDraftConnector,
  AgentGUIProviderSkillOption
} from "../../../model/agentGuiNodeTypes";

export function isConnectorOption(
  option: AgentGUIProviderSkillOption
): boolean {
  return option.sourceKind === "connector" || option.kind === "connector";
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
    if (!isConnectorOption(option)) {
      continue;
    }
    const connectorKey = option.connectorKey?.trim() ?? "";
    if (!connectorKey) {
      continue;
    }
    items.push({
      connectorKey,
      description: option.description,
      iconUrl: option.iconUrl,
      name: option.name,
      selected: selectedKeys.has(connectorKey),
      status:
        option.status === "available"
          ? "connected"
          : option.status === "disabled"
            ? "disabled"
            : option.status === "authRequired"
              ? "authorization_required"
              : "setup_required"
    });
  }
  return items;
}

export function projectConnectorSelectionItems(
  drafts: readonly AgentComposerDraftConnector[],
  options: readonly AgentGUIProviderSkillOption[]
): ConnectorSelectionItem[] {
  return drafts.map(({ connectorKey }) => {
    const option = options.find((skill) => skill.connectorKey === connectorKey);
    return {
      connectorKey,
      iconUrl: option?.iconUrl,
      name: option?.name.trim() || connectorKey
    };
  });
}

export function projectConnectorPaletteItem(
  option: AgentGUIProviderSkillOption,
  label: string,
  description?: string
): ConnectorPaletteItemModel | null {
  if (!isConnectorOption(option)) {
    return null;
  }
  const connectorKey = option.connectorKey?.trim() ?? "";
  if (!connectorKey) {
    return null;
  }
  return {
    connectorKey,
    description,
    iconUrl: option.iconUrl,
    label,
    status:
      option.status === "unsupported"
        ? "unsupported"
        : option.status === "available"
          ? "connected"
          : "setup_required"
  };
}
