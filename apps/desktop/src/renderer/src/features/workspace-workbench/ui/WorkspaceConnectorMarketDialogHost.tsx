import { ConnectorMarketDialogHost } from "@tutti-os/connector-renderer/ui";
import { createConnectorMarketI18nRuntime } from "@tutti-os/connector-renderer/i18n";
import { IConnectorMarketModule } from "@tutti-os/connector-renderer/application";
import { useService } from "@tutti-os/infra/di";
import { INotificationService } from "@tutti-os/ui-notifications";
import { useCallback, useMemo } from "react";
import { useTranslation } from "@renderer/i18n";
import { useWorkspaceSettingsService } from "./useWorkspaceSettingsService";

/** One canonical connector-market dialog host for each workbench window. */
export function WorkspaceConnectorMarketDialogHost() {
  const { i18n: appI18n, locale } = useTranslation();
  const i18n = useMemo(
    () => createConnectorMarketI18nRuntime(appI18n),
    [appI18n]
  );
  const connectorMarketModule = useService(IConnectorMarketModule);
  const notifications = useService(INotificationService);
  const { service: settingsService } = useWorkspaceSettingsService();
  const handleError = useCallback(
    (message: string) => notifications.error({ title: message }),
    [notifications]
  );

  return (
    <ConnectorMarketDialogHost
      i18n={i18n}
      locale={locale}
      onError={handleError}
      onTryConnector={() => settingsService.closePanel()}
      root={connectorMarketModule.root}
    />
  );
}
