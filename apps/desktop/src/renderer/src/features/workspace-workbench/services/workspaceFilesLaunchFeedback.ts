import { translate } from "@renderer/i18n/appRuntime";
import { Toast } from "@renderer/lib/toast";

export function showWorkspaceFileMissingToast(): void {
  Toast.Error(
    translate("workspace.workbenchDesktop.filesLaunch.openFailedTitle"),
    translate("workspace.workbenchDesktop.filesLaunch.openFailedDescription")
  );
}
