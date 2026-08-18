import type { TranslateFn } from "../../../i18n/index";

export function agentGUIConnectorLabels(t: TranslateFn) {
  return {
    addContentConnectors: t("agentHost.agentGui.addContentConnectors"),
    addContentConnectorConnected: t(
      "agentHost.agentGui.addContentConnectorConnected"
    ),
    addContentConnectorSelected: t(
      "agentHost.agentGui.addContentConnectorSelected"
    ),
    addContentConnectorConnect: t(
      "agentHost.agentGui.addContentConnectorConnect"
    ),
    addContentConnectorAuthorize: t(
      "agentHost.agentGui.addContentConnectorAuthorize"
    ),
    addContentConnectorEmpty: t("agentHost.agentGui.addContentConnectorEmpty"),
    addContentConnectorLoading: t("common.loading"),
    addContentConnectorMore: t("agentHost.agentGui.addContentConnectorMore")
  };
}
