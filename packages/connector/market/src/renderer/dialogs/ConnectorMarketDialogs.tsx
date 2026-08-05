import { Dialog } from "@tutti-os/ui-system/components";
import { useSnapshot } from "valtio";

import { useConnectorMarketServices } from "../ConnectorMarketServicesContext.tsx";
import { ConnectorAuthorizationDialog } from "./ConnectorAuthorizationDialog.tsx";
import { ConnectorBlockedDialog } from "./ConnectorBlockedDialog.tsx";
import { ConnectorManagementDialog } from "./ConnectorManagementDialog.tsx";

export function ConnectorMarketDialogs() {
  const { i18n, market, uiState, view } = useConnectorMarketServices();
  const dialog = useSnapshot(view.dataStore).dialog;
  if (!dialog) {
    return null;
  }

  return (
    <Dialog open onOpenChange={(open) => !open && uiState.closeDialog()}>
      {dialog.kind === "authorization" ? (
        <ConnectorAuthorizationDialog
          connectorKey={dialog.connectorKey}
          displayName={dialog.displayName}
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
          canAuthorize={dialog.canAuthorize}
          connectorKey={dialog.connectorKey}
          details={dialog.details}
          displayName={dialog.displayName}
          i18n={i18n}
          permissions={dialog.permissions}
          workspaceEnabled={dialog.workspaceEnabled}
          onAuthorize={() =>
            void market
              .beginAuthorization(dialog.connectorKey)
              .catch(() => undefined)
          }
          onClose={() => uiState.closeDialog()}
          onUninstall={() => {
            void market
              .uninstall(dialog.connectorKey)
              .then(() => uiState.closeDialog())
              .catch(() => undefined);
          }}
          onWorkspaceEnabledChange={(enabled) =>
            void market
              .setWorkspaceEnabled(dialog.connectorKey, enabled)
              .catch(() => undefined)
          }
        />
      ) : (
        <ConnectorBlockedDialog
          connectorKey={dialog.connectorKey}
          displayName={dialog.displayName}
          i18n={i18n}
          reason={dialog.reason}
          onClose={() => uiState.closeDialog()}
        />
      )}
    </Dialog>
  );
}
