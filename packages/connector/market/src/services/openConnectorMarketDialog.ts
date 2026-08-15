import type { IConnectorMarketRoot } from "./core/connectorMarketRoot.interface.ts";

export type OpenConnectorMarketDialogResult =
  | "connector-not-found"
  | "invalid-connector-key"
  | "opened";

/**
 * Resolves a composer/catalog entry against the authoritative market snapshot
 * before opening the package-owned connector dialog state machine.
 */
export async function openConnectorMarketDialog(
  root: IConnectorMarketRoot,
  connectorKey: string
): Promise<OpenConnectorMarketDialogResult> {
  const normalizedConnectorKey = connectorKey.trim();
  if (!normalizedConnectorKey) {
    return "invalid-connector-key";
  }

  await root.market.ensureLoaded();
  if (!root.view.dataStore.cardsByKey[normalizedConnectorKey]) {
    return "connector-not-found";
  }

  root.uiState.openConnector(normalizedConnectorKey);
  return "opened";
}
