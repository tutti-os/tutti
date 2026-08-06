import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Alert } from "react-native";
import { useServiceSnapshot } from "../bindings/useServiceSnapshot";
import { t } from "../i18n";
import {
  mobileThemePreferenceService,
  mobileUpdateService
} from "../mobileRuntime";
import { mobileSecurity } from "../native/mobileNative";
import type { MobileRootStackParamList } from "../navigation/mobileNavigation";
import type { MobileApplicationService } from "../services/mobileApplicationService";
import { SettingsScreenView } from "./SettingsScreenView";

type Props = NativeStackScreenProps<MobileRootStackParamList, "Settings"> & {
  application: MobileApplicationService;
};

export function SettingsScreen({ application, navigation }: Props) {
  const snapshot = useServiceSnapshot(application);
  const themeSnapshot = useServiceSnapshot(mobileThemePreferenceService);
  const updateSnapshot = useServiceSnapshot(mobileUpdateService);
  if (snapshot.status !== "authenticated") return null;

  const confirmSignOut = () => {
    Alert.alert(t("signOutConfirmTitle"), t("signOutConfirmDescription"), [
      { style: "cancel", text: t("cancel") },
      {
        onPress: () => void application.signOut(),
        style: "destructive",
        text: t("logout")
      }
    ]);
  };

  const changeThemePreference = (
    preference: typeof themeSnapshot.preference
  ): void => {
    void mobileThemePreferenceService.setPreference(preference).catch(() => {
      Alert.alert(t("themeSaveFailed"));
    });
  };

  const checkForSoftwareUpdate = (): void => {
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
                void mobileUpdateService.installUpdate().catch(() => {
                  Alert.alert(t("updateInstallFailed"));
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
  };

  return (
    <SettingsScreenView
      onBack={() => navigation.goBack()}
      onSoftwareUpdatePress={checkForSoftwareUpdate}
      onSignOut={confirmSignOut}
      onThemePreferenceChange={changeThemePreference}
      session={snapshot.session}
      softwareUpdateDescription={softwareUpdateDescription(
        updateSnapshot.status,
        updateSnapshot.release?.versionName,
        mobileSecurity.clientVersion
      )}
      softwareUpdateDisabled={
        updateSnapshot.status === "checking" ||
        updateSnapshot.status === "installing" ||
        updateSnapshot.status === "unsupported"
      }
      themePreference={themeSnapshot.preference}
    />
  );
}

function softwareUpdateDescription(
  status: ReturnType<typeof mobileUpdateService.getSnapshot>["status"],
  availableVersion: string | undefined,
  currentVersion: string
): string {
  switch (status) {
    case "available":
      return t("updateAvailableVersion", { version: availableVersion ?? "" });
    case "checking":
      return t("checkingForUpdates");
    case "installing":
      return t("installingUpdate");
    case "upToDate":
      return t("upToDate");
    default:
      return t("versionLabel", { version: currentVersion });
  }
}
