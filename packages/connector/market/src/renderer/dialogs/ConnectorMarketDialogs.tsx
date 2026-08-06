import { Dialog } from "@tutti-os/ui-system/components";
import { useSnapshot } from "valtio";

import { useConnectorMarketServices } from "../ConnectorMarketServicesContext.tsx";
import { ConnectorAuthorizationDialog } from "./ConnectorAuthorizationDialog.tsx";
import { ConnectorBlockedDialog } from "./ConnectorBlockedDialog.tsx";
import { ConnectorManagementDialog } from "./ConnectorManagementDialog.tsx";
import { ConnectorInstallationDialog } from "./ConnectorInstallationDialog.tsx";

export function ConnectorMarketDialogs() {
  const { i18n, market, onTryConnector, uiState, view } =
    useConnectorMarketServices();
  const dialog = useSnapshot(view.dataStore).dialog;
  if (!dialog) {
    return null;
  }

  return (
    <Dialog open onOpenChange={(open) => !open && uiState.closeDialog()}>
      {dialog.kind === "installation" ? (
        <ConnectorInstallationDialog
          description={dialog.description}
          displayName={dialog.displayName}
          iconUrl={dialog.iconUrl}
          i18n={i18n}
          installing={dialog.installing}
          onClose={() => uiState.closeDialog()}
          onInstall={() =>
            void market.install(dialog.connectorKey).catch(() => undefined)
          }
        />
      ) : dialog.kind === "authorization" ? (
        <ConnectorAuthorizationDialog
          displayName={dialog.displayName}
          iconUrl={dialog.iconUrl}
          i18n={i18n}
          pending={dialog.pending}
          permissions={dialog.permissions}
          onAuthorize={() =>
            void market
              .beginAuthorization(dialog.connectorKey)
              .catch(() => undefined)
          }
          onClose={() => uiState.closeDialog()}
        />
      ) : dialog.kind === "management" ? (
        <ConnectorManagementDialog
          description={dialog.description}
          displayName={dialog.displayName}
          iconUrl={dialog.iconUrl}
          i18n={i18n}
          onDisconnect={() => {
            const disconnect = dialog.canAuthorize
              ? market.disconnectAuthorization(dialog.connectorKey)
              : market.uninstall(dialog.connectorKey);
            void disconnect
              .then(() => uiState.closeDialog())
              .catch(() => undefined);
          }}
          onTry={() => {
            uiState.closeDialog();
            onTryConnector?.(dialog.connectorKey);
          }}
        />
      ) : (
        <ConnectorBlockedDialog
          displayName={dialog.displayName}
          iconUrl={dialog.iconUrl}
          i18n={i18n}
          reason={dialog.reason}
          onClose={() => uiState.closeDialog()}
        />
      )}
    </Dialog>
  );
}
