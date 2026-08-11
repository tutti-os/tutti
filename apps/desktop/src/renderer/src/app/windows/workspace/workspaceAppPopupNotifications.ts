import type { DesktopBrowserApi } from "@preload/types";
import type { NotificationService } from "@tutti-os/ui-notifications";
import type { DesktopI18nKey } from "../../../../../shared/i18n/index.ts";

export function registerWorkspaceAppPopupNotifications(input: {
  browserApi:
    | Pick<DesktopBrowserApi, "onWorkspaceAppPopupRejected">
    | null
    | undefined;
  notifications: Pick<NotificationService, "error">;
  translate(key: DesktopI18nKey): string;
}): () => void {
  return (
    input.browserApi?.onWorkspaceAppPopupRejected?.(() => {
      input.notifications.error({
        description: input.translate(
          "workspaceAppPopup.postUnsupportedDescription"
        ),
        title: input.translate("workspaceAppPopup.postUnsupportedTitle")
      });
    }) ?? (() => undefined)
  );
}
