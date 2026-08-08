import { Alert } from "react-native";
import { t } from "../i18n";
import {
  MOBILE_UPDATE_CANCELLED,
  mobileUpdateErrorCode,
  type MobileUpdateService
} from "../services/mobileUpdateService";

export function presentMobileSoftwareUpdate(
  mobileUpdateService: MobileUpdateService
): void {
  void mobileUpdateService
    .checkForUpdates()
    .then((nextSnapshot) => {
      if (nextSnapshot.status === "unsupported") {
        Alert.alert(t("softwareUpdate"), t("updatesUnavailable"));
        return;
      }
      if (nextSnapshot.status === "upToDate") {
        Alert.alert(t("softwareUpdate"), t("upToDate"));
        return;
      }
      if (nextSnapshot.status !== "available" || !nextSnapshot.release) {
        return;
      }

      Alert.alert(
        t("updateAvailable"),
        t("updateAvailableDescription", {
          version: nextSnapshot.release.versionName
        }),
        [
          { style: "cancel", text: t("cancel") },
          {
            onPress: () => {
              void mobileUpdateService.installUpdate().catch((error) => {
                const code = mobileUpdateErrorCode(error);
                if (code === MOBILE_UPDATE_CANCELLED) return;
                Alert.alert(
                  t("updateInstallFailed"),
                  updateInstallFailureDescription(code)
                );
              });
            },
            text: t("downloadAndInstall")
          }
        ]
      );
    })
    .catch(() => {
      Alert.alert(t("updateCheckFailed"));
    });
}

export function updateInstallFailureDescription(code: string | null): string {
  if (
    code === "UPDATE_STORAGE_INSUFFICIENT" ||
    code === "UPDATE_INSTALL_STORAGE_INSUFFICIENT"
  ) {
    return t("updateStorageInsufficient");
  }
  if (
    code?.startsWith("UPDATE_CHECKSUM_") ||
    code === "UPDATE_SIZE_INVALID" ||
    code === "UPDATE_SIZE_MISMATCH"
  ) {
    return t("updateIntegrityFailed");
  }
  if (code === "UPDATE_DOWNLOAD_SERVER_FAILED") {
    return t("updateDownloadFailed");
  }
  if (code === "UPDATE_DOWNLOAD_FILE_FAILED") {
    return t("updateDownloadFileFailed");
  }
  if (
    code === "UPDATE_DOWNLOAD_MANAGER_FAILED" ||
    code === "UPDATE_DOWNLOAD_QUERY_FAILED"
  ) {
    return t("updateDownloadStatusFailed");
  }
  if (code === "UPDATE_INSTALL_PERMISSION_REQUIRED") {
    return t("updateInstallPermissionRequired");
  }
  if (code === "UPDATE_INSTALL_CONFLICT") {
    return t("updateInstallConflict");
  }
  if (code === "UPDATE_INSTALL_INCOMPATIBLE") {
    return t("updateInstallIncompatible");
  }
  if (code === "UPDATE_INSTALL_BLOCKED") {
    return t("updateInstallBlocked");
  }
  if (code === "UPDATE_INSTALL_PACKAGE_INVALID") {
    return t("updateInstallPackageInvalid");
  }
  if (code === "UPDATE_INSTALL_DEFERRED") {
    return t("updateInstallDeferred");
  }
  return t("updateInstallFailedDescription");
}
