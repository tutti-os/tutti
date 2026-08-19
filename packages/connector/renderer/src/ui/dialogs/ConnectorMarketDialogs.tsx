import {
  ConfirmationDialog,
  Dialog,
  ToastProvider,
  ToastRoot,
  ToastTitle,
  ToastViewport
} from "@tutti-os/ui-system/components";
import { useCallback, useEffect, useState } from "react";
import { useSnapshot } from "valtio";
import type { AuthorizationViewEnvelopeV1 } from "@tutti-os/connector-contracts/authorization/v1";

import { useConnectorMarketServices } from "../ConnectorMarketServicesContext.tsx";
import { ConnectorAuthorizationDialog } from "./ConnectorAuthorizationDialog.tsx";
import { ConnectorBlockedDialog } from "./ConnectorBlockedDialog.tsx";
import { ConnectorManagementDialog } from "./ConnectorManagementDialog.tsx";
import { ConnectorInstallationDialog } from "./ConnectorInstallationDialog.tsx";

interface UninstallSuccessToast {
  displayName: string;
  operationId: string;
}

export function ConnectorMarketDialogs() {
  const {
    authorizationRenderer,
    i18n,
    locale,
    market,
    onError,
    onTryConnector,
    uiState,
    view
  } = useConnectorMarketServices();
  const dialog = useSnapshot(view.dataStore).dialog;
  const dialogRequest = useSnapshot(uiState.dataStore).dialog;
  const marketSnapshot = useSnapshot(market.dataStore);
  const [showSuccessToast, setShowSuccessToast] = useState<
    "authorize" | "install" | null
  >(null);
  const [uninstallSubmitting, setUninstallSubmitting] = useState(false);
  const [uninstallSuccess, setUninstallSuccess] =
    useState<UninstallSuccessToast | null>(null);
  const authorizeConnector = useCallback(
    (connectorKey: string, secret?: string) => {
      setShowSuccessToast(null);
      return market
        .beginAuthorization(connectorKey, secret)
        .then(() => {
          setShowSuccessToast("authorize");
          uiState.closeDialog();
        })
        .catch((error: unknown) => {
          if (
            !error ||
            typeof error !== "object" ||
            !("code" in error) ||
            error.code !== "connector_authorization_canceled"
          ) {
            const code =
              typeof error === "object" && error !== null && "code" in error
                ? error.code
                : undefined;
            onError?.(
              i18n.t(
                code === "connector_authorization_timeout"
                  ? "connectorAuthorizationTimedOut"
                  : "connectorAuthorizationFailed"
              )
            );
          }
        });
    },
    [i18n, market, onError, uiState]
  );

  useEffect(() => {
    for (const tracked of Object.values(
      marketSnapshot.pendingUninstallNotificationsByOperationId
    )) {
      if (tracked.state === "failed") {
        onError?.(i18n.t("connectorUninstallFailed"));
        market.dismissUninstallNotification(tracked.operationId);
        continue;
      }
      if (tracked.state === "completed" && !uninstallSuccess) {
        setUninstallSuccess({
          displayName: tracked.displayName,
          operationId: tracked.operationId
        });
        return;
      }
    }
  }, [
    i18n,
    market,
    marketSnapshot.pendingUninstallNotificationsByOperationId,
    onError,
    uninstallSuccess
  ]);

  useEffect(() => {
    if (dialogRequest?.kind === "uninstall_confirmation" && !dialog) {
      uiState.closeDialog();
    }
  }, [dialog, dialogRequest?.kind, uiState]);

  if (!dialog && !showSuccessToast && !uninstallSuccess) {
    return null;
  }

  // Hide management dialog when showing success toast
  const shouldHideDialog =
    dialog?.kind === "management" &&
    Boolean(showSuccessToast || uninstallSuccess);

  const cancelAuthorizationDialog = () => {
    if (dialog?.kind !== "authorization") {
      uiState.closeDialog();
      return;
    }
    if (!dialog.authorizing && !dialog.pending) {
      uiState.closeDialog();
      return;
    }
    void market
      .cancelAuthorization(dialog.connectorKey)
      .catch(() => {
        onError?.(i18n.t("connectorAuthorizationFailed"));
      })
      .finally(() => uiState.closeDialog());
  };

  return (
    <>
      {dialog?.kind === "uninstall_confirmation" ? (
        <ConfirmationDialog
          cancelLabel={i18n.t("cancel")}
          confirmBusy={uninstallSubmitting}
          confirmLabel={
            uninstallSubmitting
              ? i18n.t("actionUninstalling")
              : i18n.t("actionUninstall")
          }
          description={i18n.t("dialogUninstallDescription")}
          open
          title={i18n.t("dialogUninstallTitle", {
            name: dialog.displayName
          })}
          tone="destructive"
          onConfirm={() => {
            if (uninstallSubmitting) {
              return;
            }
            setUninstallSubmitting(true);
            void market
              .uninstall(dialog.connectorKey)
              .then(() => {
                uiState.closeDialog();
              })
              .catch(() => {
                onError?.(i18n.t("connectorUninstallFailed"));
              })
              .finally(() => setUninstallSubmitting(false));
          }}
          onOpenChange={(open) => {
            if (!open && !uninstallSubmitting) {
              uiState.closeDialog();
            }
          }}
        />
      ) : dialog && !shouldHideDialog ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (open || (dialog.kind === "installation" && dialog.installing)) {
              return;
            }
            uiState.closeDialog();
          }}
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
                  .then((outcome) => {
                    if (outcome !== "installed") {
                      return;
                    }
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
              authorizationInteraction={dialog.authorizationInteraction}
              authorizationKind={dialog.authorizationKind}
              authorizationRenderer={authorizationRenderer}
              authorizationView={
                dialog.authorizationView as
                  | AuthorizationViewEnvelopeV1
                  | undefined
              }
              authorizing={dialog.authorizing}
              brokeredAuthorization={dialog.brokeredAuthorization}
              displayName={dialog.displayName}
              iconUrl={dialog.iconUrl}
              i18n={i18n}
              locale={locale}
              pending={dialog.pending}
              onCancel={cancelAuthorizationDialog}
              onAuthorize={(secret) =>
                authorizeConnector(dialog.connectorKey, secret)
              }
              onClose={() => uiState.closeDialog()}
              onOpenAuthorizationUrl={(url) => market.openAuthorizationUrl(url)}
            />
          ) : dialog.kind === "management" ? (
            <ConnectorManagementDialog
              canDisconnectAuthorization={dialog.canAuthorize}
              canUninstall={dialog.canUninstall}
              description={dialog.description}
              displayName={dialog.displayName}
              iconUrl={dialog.iconUrl}
              i18n={i18n}
              onDisconnect={() => {
                void market
                  .disconnectAuthorization(dialog.connectorKey)
                  .then(() => uiState.closeDialog())
                  .catch(() => {
                    onError?.(i18n.t("connectorDisconnectFailed"));
                  });
              }}
              onRequestUninstall={() =>
                uiState.requestUninstall(dialog.connectorKey)
              }
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
      {uninstallSuccess ? (
        <ToastProvider>
          <ToastRoot
            open
            variant="success"
            onOpenChange={(open) => {
              if (!open) {
                market.dismissUninstallNotification(
                  uninstallSuccess.operationId
                );
                setUninstallSuccess(null);
              }
            }}
          >
            <ToastTitle>
              {i18n.t("connectorUninstallSuccess", {
                name: uninstallSuccess.displayName
              })}
            </ToastTitle>
          </ToastRoot>
          <ToastViewport />
        </ToastProvider>
      ) : null}
    </>
  );
}
