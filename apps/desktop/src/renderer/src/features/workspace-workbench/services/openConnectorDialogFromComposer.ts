import type { ConnectorMarketRootService } from "@tutti-os/connector-market/services";

export type ComposerConnectorOpenResult = "dialog-opened" | "no-action";

export async function openConnectorDialogFromComposer(
  root: ConnectorMarketRootService,
  connectorKey: string
): Promise<ComposerConnectorOpenResult> {
  const normalizedConnectorKey = connectorKey.trim();
  if (!normalizedConnectorKey) {
    return "no-action";
  }

  await root.market.ensureLoaded();
  if (!root.view.dataStore.cardsByKey[normalizedConnectorKey]) {
    return "no-action";
  }
  root.uiState.openConnector(normalizedConnectorKey);
  return "dialog-opened";
}
