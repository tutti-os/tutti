import type { NotificationService } from "@tutti-os/ui-notifications";

export interface DesktopConnectorAccountLogin {
  startLogin(): Promise<{ error: string | null }>;
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
