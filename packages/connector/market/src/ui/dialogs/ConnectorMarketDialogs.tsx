import {
  Dialog,
  ToastProvider,
  ToastRoot,
  ToastTitle,
  ToastViewport
} from "@tutti-os/ui-system/components";
import { useState } from "react";
import { useSnapshot } from "valtio";

import { useConnectorMarketServices } from "../ConnectorMarketServicesContext.tsx";
import { ConnectorAuthorizationDialog } from "./ConnectorAuthorizationDialog.tsx";
import { ConnectorBlockedDialog } from "./ConnectorBlockedDialog.tsx";
import { ConnectorManagementDialog } from "./ConnectorManagementDialog.tsx";
import { ConnectorInstallationDialog } from "./ConnectorInstallationDialog.tsx";

export function ConnectorMarketDialogs() {
  const { i18n, market, onError, onTryConnector, uiState, view } =
    useConnectorMarketServices();
  const dialog = useSnapshot(view.dataStore).dialog;
  const [showSuccessToast, setShowSuccessToast] = useState<
    "authorize" | "install" | null
  >(null);

  if (!dialog && !showSuccessToast) {
    return null;
  }

  // Hide management dialog when showing success toast
  const shouldHideDialog = dialog?.kind === "management" && showSuccessToast;

  return (
    <>
      {dialog && !shouldHideDialog ? (
        <Dialog
          open
          onOpenChange={(open) =>
            !open &&
            !(dialog.kind === "installation" && dialog.installing) &&
            uiState.closeDialog()
          }
        >
          {dialog.kind === "installation" ? (
            <ConnectorInstallationDialog
              description={dialog.description}
              displayName={dialog.displayName}
              i18n={i18n}
              installing={dialog.installing}
              updating={dialog.updating}
              onClose={() => uiState.closeDialog()}
              onInstall={() => {
                setShowSuccessToast(null);
                void market
                  .install(dialog.connectorKey)
                  .then(() => {
                    setShowSuccessToast("install");
                    uiState.closeDialog();
                  })
                  .catch(() => {
                    onError?.(
                      i18n.t(
                        dialog.updating
                          ? "connectorUpdateFailed"
                          : "connectorInstallFailed"
                      )
                    );
                  });
              }}
            />
          ) : dialog.kind === "authorization" ? (
            <ConnectorAuthorizationDialog
              authorizationKind={dialog.authorizationKind}
              authorizing={dialog.authorizing}
              displayName={dialog.displayName}
              iconUrl={dialog.iconUrl}
              i18n={i18n}
              pending={dialog.pending}
              permissions={dialog.permissions}
              onAuthorize={(secret) => {
                setShowSuccessToast(null);
                return market
                  .beginAuthorization(dialog.connectorKey, secret)
                  .then(() => {
                    setShowSuccessToast("authorize");
                    uiState.closeDialog();
                  })
                  .catch(() => {
                    onError?.(i18n.t("connectorAuthorizationFailed"));
                  });
              }}
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
      ) : null}
      {showSuccessToast ? (
        <ToastProvider>
          <ToastRoot
            open
            variant="success"
            onOpenChange={(open) => !open && setShowSuccessToast(null)}
          >
            <ToastTitle>
              {i18n.t(
                showSuccessToast === "install"
                  ? "actionInstallSuccess"
                  : "actionAuthorizeSuccess"
              )}
            </ToastTitle>
          </ToastRoot>
          <ToastViewport />
        </ToastProvider>
      ) : null}
    </>
  );
}
