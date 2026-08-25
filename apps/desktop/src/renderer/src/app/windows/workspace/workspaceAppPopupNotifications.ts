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
    input.browserApi?.onWorkspaceAppPopupRejected?.((event) => {
      const [descriptionKey, titleKey] =
        event.reason === "deferred-navigation-unsupported"
          ? ([
              "workspaceAppPopup.deferredUnsupportedDescription",
              "workspaceAppPopup.deferredUnsupportedTitle"
            ] as const)
          : ([
              "workspaceAppPopup.postUnsupportedDescription",
              "workspaceAppPopup.postUnsupportedTitle"
            ] as const);
      input.notifications.error({
        description: input.translate(descriptionKey),
        title: input.translate(titleKey)
      });
    }) ?? (() => undefined)
  );
}
