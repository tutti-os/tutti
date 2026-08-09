import {
  NativeButton,
  NativeProgressBar,
  type NativeTheme,
  useNativeTheme
} from "@tutti-os/ui-system/native";
import { useState } from "react";
import { Alert, Modal, StyleSheet, Text, View } from "react-native";
import { t } from "../i18n";
import type {
  MobileUpdateProgress,
  MobileUpdateSnapshot
} from "../services/mobileUpdateService";

interface MobileSoftwareUpdateOverlayProps {
  onCancel(): Promise<unknown>;
  snapshot: MobileUpdateSnapshot;
}

export function MobileSoftwareUpdateOverlay({
  onCancel,
  snapshot
}: MobileSoftwareUpdateOverlayProps) {
  const theme = useNativeTheme();
  const styles = createStyles(theme);
  const [cancelling, setCancelling] = useState(false);
  const progress = snapshot.progress;
  if (snapshot.status !== "installing" || !progress) return null;

  const cancellable = isCancellable(progress);
  const value =
    progress.phase === "downloading" &&
    !progress.indeterminate &&
    progress.totalBytes
      ? progress.downloadedBytes / progress.totalBytes
      : null;
  const description = progressDescription(progress);
  const cancel = (): void => {
    if (!cancellable || cancelling) return;
    setCancelling(true);
    void onCancel()
      .catch(() => Alert.alert(t("updateCancelFailed")))
      .finally(() => setCancelling(false));
  };

  return (
    <Modal
      animationType="fade"
      onRequestClose={cancellable ? cancel : () => undefined}
      statusBarTranslucent
      transparent
      visible
    >
      <View accessibilityViewIsModal style={styles.backdrop}>
        <View style={styles.card}>
          <Text accessibilityRole="header" style={styles.title}>
            {progressTitle(progress)}
          </Text>
          <Text style={styles.description}>{description}</Text>
          <NativeProgressBar
            accessibilityLabel={t("updateProgressAccessibility")}
            testID="mobile-update-progress"
            value={value}
          />
          {cancellable ? (
            <NativeButton
              label={t("cancelUpdate")}
              loading={cancelling}
              onPress={cancel}
              size="large"
              style={styles.action}
              variant="secondary"
            />
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

function progressTitle(progress: MobileUpdateProgress): string {
  switch (progress.phase) {
    case "downloading":
      return t("downloadingUpdate");
    case "paused":
      return t("updateDownloadPaused");
    case "verifying":
      return t("verifyingUpdate");
    case "opening_installer":
      return t("preparingUpdateInstaller");
    case "awaiting_install_confirmation":
      return t("confirmUpdateInstallation");
    case "awaiting_install_permission":
      return t("allowUpdateInstallation");
    default:
      return t("preparingUpdateDownload");
  }
}

function progressDescription(progress: MobileUpdateProgress): string {
  switch (progress.phase) {
    case "downloading":
      return progress.totalBytes
        ? t("updateDownloadProgress", {
            downloaded: formatBytes(progress.downloadedBytes),
            total: formatBytes(progress.totalBytes)
          })
        : t("updateDownloadInProgress");
    case "paused":
      return t("updateDownloadPausedDescription");
    case "verifying":
      return t("verifyingUpdateDescription");
    case "opening_installer":
      return t("preparingUpdateInstallerDescription");
    case "awaiting_install_confirmation":
      return t("confirmUpdateInstallationDescription");
    case "awaiting_install_permission":
      return t("allowUpdateInstallationDescription");
    default:
      return t("preparingUpdateDownloadDescription");
  }
}

function isCancellable(progress: MobileUpdateProgress): boolean {
  return ["preparing", "queued", "downloading", "paused", "verifying"].includes(
    progress.phase
  );
}

function formatBytes(bytes: number): string {
  const megabytes = bytes / (1024 * 1024);
  return `${megabytes < 10 ? megabytes.toFixed(1) : megabytes.toFixed(0)} MB`;
}

function createStyles(theme: NativeTheme) {
  return StyleSheet.create({
    action: { width: "100%" },
    backdrop: {
      alignItems: "center",
      backgroundColor: theme.color.scrim,
      flex: 1,
      justifyContent: "center",
      padding: theme.space.large
    },
    card: {
      alignItems: "center",
      backgroundColor: theme.color.panelRaised,
      borderColor: theme.color.border,
      borderRadius: theme.radius.large,
      borderWidth: StyleSheet.hairlineWidth,
      gap: theme.space.medium,
      maxWidth: 420,
      padding: theme.space.large,
      width: "100%"
    },
    description: {
      color: theme.color.textSecondary,
      fontSize: 15,
      lineHeight: 22,
      textAlign: "center"
    },
    title: {
      color: theme.color.text,
      fontSize: 20,
      fontWeight: "700",
      textAlign: "center"
    }
  });
}
