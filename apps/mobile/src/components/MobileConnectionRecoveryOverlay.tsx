import {
  NativeButton,
  type NativeTheme,
  useNativeTheme
} from "@tutti-os/ui-system/native";
import { ActivityIndicator, Modal, StyleSheet, Text, View } from "react-native";
import { t } from "../i18n";
import type { MobileConnectionSnapshot } from "../services/mobileApplicationService";

interface MobileConnectionRecoveryOverlayProps {
  connection: MobileConnectionSnapshot;
  onBackToDevices(): void;
  onCheckForUpdates(): void;
  onRetry(): void;
}

export function MobileConnectionRecoveryOverlay({
  connection,
  onBackToDevices,
  onCheckForUpdates,
  onRetry
}: MobileConnectionRecoveryOverlayProps) {
  const theme = useNativeTheme();
  const styles = createStyles(theme);
  if (connection.phase === "idle" || connection.phase === "connected") {
    return null;
  }
  const failed = connection.phase === "failed";
  const protocolIncompatible =
    failed && connection.reasonCode === "protocol_revision_mismatch";

  return (
    <Modal
      animationType="fade"
      onRequestClose={onBackToDevices}
      statusBarTranslucent
      transparent
      visible
    >
      <View accessibilityViewIsModal style={styles.backdrop}>
        <View style={styles.card}>
          {failed ? null : (
            <ActivityIndicator color={theme.color.accent} size="large" />
          )}
          <Text accessibilityRole="header" style={styles.title}>
            {failed
              ? protocolIncompatible
                ? t("connectionVersionIncompatibleTitle")
                : t("connectionRecoveryFailedTitle")
              : connection.phase === "synchronizing"
                ? t("connectionSynchronizingTitle")
                : t("connectionReconnectingTitle")}
          </Text>
          <Text style={styles.description}>
            {failed
              ? protocolIncompatible
                ? t("connectionVersionIncompatibleDescription")
                : t("connectionRecoveryFailedDescription")
              : t("connectionRecoveryDescription")}
          </Text>
          <View style={styles.actions}>
            {failed ? (
              <NativeButton
                label={
                  protocolIncompatible
                    ? t("checkForUpdates")
                    : t("retryConnection")
                }
                onPress={protocolIncompatible ? onCheckForUpdates : onRetry}
                size="large"
              />
            ) : null}
            <NativeButton
              label={t("backToDevices")}
              onPress={onBackToDevices}
              size="large"
              variant="secondary"
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

function createStyles(theme: NativeTheme) {
  return StyleSheet.create({
    actions: {
      gap: theme.space.small,
      marginTop: theme.space.small,
      width: "100%"
    },
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
