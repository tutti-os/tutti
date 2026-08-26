import type { NotificationService } from "@tutti-os/ui-notifications";
import {
  isFeatureEnabled,
  LAB_CONNECTORS_FLAG
} from "../../../../../shared/featureFlags/catalog.ts";
import type { DesktopFeatureFlags } from "../../../../../shared/preferences/index.ts";

export interface DesktopConnectorAccountLogin {
  startLogin(): Promise<{ error: string | null }>;
}

export function canRequestDesktopConnectorMarket(
  authenticated: boolean,
  featureFlags: DesktopFeatureFlags
): boolean {
  return authenticated && isFeatureEnabled(featureFlags, LAB_CONNECTORS_FLAG);
}

export async function requestDesktopConnectorInstallAdmission(
  accountLogin: DesktopConnectorAccountLogin,
  notifications: Pick<NotificationService, "error">,
  failureTitle: string
): Promise<void> {
  const result = await accountLogin.startLogin();
  const error = result.error?.trim();
  if (error) {
    notifications.error({
      description: error,
      title: failureTitle
    });
  }
}
