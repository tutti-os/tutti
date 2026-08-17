import type { NotificationService } from "@tutti-os/ui-notifications";
import type { IAccountService } from "../services/accountService.interface";

export async function startWorkspaceAccountLogin(
  accountService: Pick<IAccountService, "startLogin">,
  notifications: Pick<NotificationService, "error">,
  failureTitle: string
): Promise<void> {
  const result = await accountService.startLogin();
  const error = result.error?.trim();
  if (error) {
    notifications.error({
      description: error,
      title: failureTitle
    });
  }
}
