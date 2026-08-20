import type { IConnectorMarketRoot } from "./core/connectorMarketRoot.interface.ts";

export type OpenConnectorMarketDialogResult =
  | "connector-not-found"
  | "invalid-connector-key"
  | "opened";

export type InstallAndOpenConnectorMarketDialogResult =
  | OpenConnectorMarketDialogResult
  | "not_admitted";

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

/**
 * Installs a composer connector and opens its canonical post-install dialog.
 * The reconciled connector state determines whether that dialog presents
 * authorization or management; failed admission never opens a dialog.
 */
export async function installAndOpenConnectorMarketDialog(
  root: IConnectorMarketRoot,
  connectorKey: string
): Promise<InstallAndOpenConnectorMarketDialogResult> {
  const normalizedConnectorKey = connectorKey.trim();
  if (!normalizedConnectorKey) {
    return "invalid-connector-key";
  }

  const outcome = await root.market.install(normalizedConnectorKey);
  if (outcome !== "installed") {
    return outcome;
  }
  return openConnectorMarketDialog(root, normalizedConnectorKey);
}
