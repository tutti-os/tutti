import { useMemo } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from "react-native";
import {
  NativeAvatar,
  NativeIconButton,
  NativeSheet,
  type NativeTheme,
  useNativeTheme
} from "@tutti-os/ui-system/native";
import tuttiMark from "../assets/tutti-mark.png";
import {
  MobileComputerGlyph,
  MobilePairingGlyph,
  MobileQRCodeGlyph
} from "../components/MobileLocationGlyphs";
import {
  MobileKeyboardAvoidingView,
  mobileKeyboardDismissMode
} from "../components/MobileKeyboardAvoidingView";
import { PrimaryButton } from "../components/PrimaryButton";
import { t } from "../i18n";
import type { DeviceSnapshot } from "../services/deviceService";
import type { DevicePairing, UserDevice } from "../services/mobileDomain";

export interface DeviceScreenViewProps {
  accountAvatarURL: string;
  accountName: string;
  manualPairingCode: string;
  manualPairingOpen: boolean;
  model: DeviceSnapshot;
  onConnect(pairing: DevicePairing, device?: UserDevice): void;
  onManualPairingCodeChange(value: string): void;
  onManualPairingClose(): void;
  onManualPairingSubmit(): void;
  onOpenSettings(): void;
  onRefresh(): void;
  onScanPairingCode(): void;
}

export function DeviceScreenView({
  accountAvatarURL,
  accountName,
  manualPairingCode,
  manualPairingOpen,
  model,
  onConnect,
  onManualPairingCodeChange,
  onManualPairingClose,
  onManualPairingSubmit,
  onOpenSettings,
  onRefresh,
  onScanPairingCode
}: DeviceScreenViewProps) {
  const theme = useNativeTheme();
  const styles = createStyles(theme);
  const devicesById = useMemo(
    () => new Map(model.devices.map((device) => [device.userDeviceId, device])),
    [model.devices]
  );
  const pairingAvailable =
    model.pairingState === "idle" || model.pairingState === "confirmed";
  const error =
    model.errorCode === "camera_permission_required"
      ? t("cameraPermissionRequired")
      : model.errorCode === "scanner_unavailable"
        ? t("scannerUnavailable")
        : model.errorCode === "pairing_failed"
          ? t("pairingFailed")
          : model.errorCode === "connection_failed"
            ? t("connectionFailed")
            : model.errorCode === "workspace_unavailable"
              ? t("workspaceUnavailable")
              : model.errorCode
                ? t("genericError")
                : null;
  const pairingStatus =
    model.pairingState === "claiming"
      ? t("pairing")
      : model.pairingState === "waiting"
        ? t("pairingWaiting")
        : model.pairingState === "confirmed"
          ? t("pairingConfirmed")
          : null;
  const feedback = error ?? pairingStatus;
  const feedbackBusy =
    !error &&
    (model.pairingState === "claiming" || model.pairingState === "waiting");

  return (
    <MobileKeyboardAvoidingView style={styles.root}>
      <View style={styles.header}>
        <View style={styles.brand}>
          <Image
            accessibilityElementsHidden
            resizeMode="contain"
            source={tuttiMark}
            style={styles.brandMark}
          />
          <Text style={styles.brandName}>{t("appName")}</Text>
        </View>
        <View style={styles.headerActions}>
          <NativeIconButton
            accessibilityLabel={t("pairAction")}
            disabled={!pairingAvailable}
            icon={<MobileQRCodeGlyph color={theme.color.text} size={18} />}
            onPress={onScanPairingCode}
            size="compact"
          />
          <Pressable
            accessibilityLabel={t("openSettings")}
            accessibilityRole="button"
            onPress={onOpenSettings}
            style={({ pressed }) => [
              styles.avatarButton,
              pressed ? styles.pressed : undefined
            ]}
          >
            <NativeAvatar
              label={accountName || t("appName")}
              size="compact"
              src={accountAvatarURL}
            />
          </Pressable>
        </View>
      </View>

      <ScrollView
        style={styles.list}
        contentContainerStyle={styles.content}
        keyboardDismissMode={mobileKeyboardDismissMode}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            onRefresh={onRefresh}
            refreshing={model.refreshing}
            tintColor={theme.color.textSecondary}
          />
        }
      >
        {feedback ? (
          <View
            style={[styles.feedback, error ? styles.feedbackError : undefined]}
          >
            {feedbackBusy ? (
              <ActivityIndicator color={theme.color.accent} size="small" />
            ) : (
              <View
                style={[
                  styles.feedbackDot,
                  error ? styles.feedbackDotError : undefined
                ]}
              />
            )}
            <Text style={styles.feedbackText}>{feedback}</Text>
          </View>
        ) : null}

        {model.pairings.length === 0 && !model.refreshing ? (
          <View style={styles.empty}>
            <MobilePairingGlyph color={theme.color.accent} size={72} />
            <Text style={styles.emptyTitle}>{t("deviceEmptyTitle")}</Text>
            <Text style={styles.emptyBody}>{t("deviceEmpty")}</Text>
            <PrimaryButton
              disabled={!pairingAvailable}
              leading={
                <MobileQRCodeGlyph color={theme.color.background} size={18} />
              }
              label={t("pairAction")}
              loading={model.pairingState === "claiming"}
              onPress={onScanPairingCode}
              size="regular"
              style={styles.emptyAction}
            />
          </View>
        ) : null}
        {model.pairings.map((pairing) => {
          const device = devicesById.get(pairing.targetUserDeviceId);
          const connecting = model.connectingPairingId === pairing.pairingId;
          return (
            <Pressable
              accessibilityState={{ busy: connecting }}
              disabled={model.connectingPairingId !== null}
              key={pairing.pairingId}
              onPress={() => onConnect(pairing, device)}
              style={({ pressed }) => pressed && styles.pressed}
            >
              <View style={styles.card}>
                <View style={styles.cardRow}>
                  <View style={styles.cardLeading}>
                    <MobileComputerGlyph
                      color={theme.color.textSecondary}
                      size={22}
                    />
                  </View>
                  <View style={styles.cardCopy}>
                    <Text numberOfLines={1} style={styles.deviceName}>
                      {device?.displayName ||
                        device?.reportedName ||
                        t("desktopFallback")}
                    </Text>
                    <View style={styles.cardStatus}>
                      {connecting ? (
                        <View style={styles.statusPill}>
                          <ActivityIndicator
                            color={theme.color.accent}
                            size="small"
                          />
                          <Text numberOfLines={1} style={styles.cardStatusText}>
                            {t("connectingShort")}
                          </Text>
                        </View>
                      ) : null}
                    </View>
                  </View>
                </View>
              </View>
            </Pressable>
          );
        })}
      </ScrollView>

      <NativeSheet
        closeAccessibilityLabel={t("closeSheet")}
        onOpenChange={(open) => {
          if (!open) onManualPairingClose();
        }}
        open={manualPairingOpen}
      >
        <View style={styles.manualSheet}>
          <View style={styles.manualHeader}>
            <Text style={styles.manualTitle}>{t("pairingCodeAction")}</Text>
            <NativeIconButton
              accessibilityLabel={t("closeSheet")}
              icon={<Text style={styles.closeIcon}>×</Text>}
              onPress={onManualPairingClose}
              size="compact"
            />
          </View>
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus={manualPairingOpen}
            onChangeText={onManualPairingCodeChange}
            onSubmitEditing={onManualPairingSubmit}
            placeholder={t("pairingCodeHint")}
            placeholderTextColor={theme.color.muted}
            style={styles.manualInput}
            value={manualPairingCode}
          />
          <PrimaryButton
            disabled={!manualPairingCode.trim() || !pairingAvailable}
            label={t("pairingCodeSubmit")}
            loading={model.pairingState === "claiming"}
            onPress={onManualPairingSubmit}
          />
        </View>
      </NativeSheet>
    </MobileKeyboardAvoidingView>
  );
}

function createStyles(theme: NativeTheme) {
  return StyleSheet.create({
    avatarButton: {
      alignItems: "center",
      justifyContent: "center",
      minHeight: theme.control.regular,
      minWidth: theme.control.regular
    },
    brand: {
      alignItems: "center",
      flexDirection: "row",
      gap: theme.space.small
    },
    brandMark: { height: 26, width: 26 },
    brandName: {
      color: theme.color.text,
      fontSize: theme.space.medium + 2,
      fontWeight: "700"
    },
    card: {
      alignSelf: "stretch",
      alignItems: "center",
      backgroundColor: theme.color.panelRaised,
      borderColor: theme.color.border,
      borderRadius: theme.radius.medium,
      borderWidth: StyleSheet.hairlineWidth,
      elevation: 2,
      minHeight: theme.control.row,
      paddingHorizontal: theme.space.medium,
      width: "100%",
      shadowColor: theme.color.text,
      shadowOffset: { height: 2, width: 0 },
      shadowOpacity: 0.06,
      shadowRadius: 5
    },
    cardRow: {
      alignItems: "center",
      flexDirection: "row",
      minHeight: theme.control.row,
      width: "100%"
    },
    cardLeading: {
      alignItems: "center",
      justifyContent: "center",
      marginRight: theme.space.small,
      width: 28
    },
    cardCopy: {
      alignItems: "center",
      flex: 1,
      flexDirection: "row",
      minWidth: 0
    },
    cardStatus: {
      alignItems: "center",
      flexDirection: "row",
      flexShrink: 0,
      justifyContent: "flex-end",
      marginLeft: theme.space.small,
      minWidth: 0
    },
    cardStatusText: {
      color: theme.color.accent,
      flexShrink: 1,
      fontSize: theme.space.small + 1,
      fontWeight: "600",
      maxWidth: 112,
      marginLeft: 4
    },
    closeIcon: { color: theme.color.text, fontSize: 24, lineHeight: 24 },
    content: {
      flexGrow: 1,
      gap: theme.space.medium,
      paddingBottom: theme.space.xlarge,
      paddingHorizontal: theme.space.large,
      paddingTop: theme.space.medium
    },
    deviceName: {
      color: theme.color.text,
      flex: 1,
      minWidth: 0,
      fontSize: theme.space.medium,
      fontWeight: "700"
    },
    empty: {
      alignItems: "center",
      flex: 1,
      justifyContent: "center",
      minHeight: 380,
      paddingHorizontal: theme.space.large
    },
    emptyAction: {
      marginTop: theme.space.medium,
      minWidth: 180
    },
    emptyBody: {
      color: theme.color.textSecondary,
      fontSize: theme.space.small + 4,
      lineHeight: theme.space.medium + 4,
      marginTop: theme.space.small,
      textAlign: "center"
    },
    emptyTitle: {
      color: theme.color.text,
      fontSize: theme.space.medium + 2,
      fontWeight: "700",
      marginTop: theme.space.medium
    },
    feedback: {
      alignItems: "center",
      alignSelf: "stretch",
      backgroundColor: theme.color.panelRaised,
      borderColor: theme.color.border,
      borderRadius: theme.radius.medium,
      borderWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      gap: theme.space.small,
      paddingHorizontal: theme.space.medium,
      paddingVertical: theme.space.small
    },
    feedbackDot: {
      backgroundColor: theme.color.success,
      borderRadius: 4,
      height: 8,
      width: 8
    },
    feedbackDotError: { backgroundColor: theme.color.danger },
    feedbackError: { borderColor: theme.color.danger },
    feedbackText: { color: theme.color.textSecondary, flex: 1, fontSize: 13 },
    header: {
      alignItems: "center",
      backgroundColor: theme.color.panelRaised,
      borderBottomColor: theme.color.border,
      borderBottomWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      justifyContent: "space-between",
      paddingHorizontal: theme.space.large,
      paddingVertical: theme.space.small
    },
    headerActions: {
      alignItems: "center",
      flexDirection: "row",
      gap: theme.space.small
    },
    list: { backgroundColor: theme.color.panel },
    manualHeader: {
      alignItems: "center",
      flexDirection: "row",
      justifyContent: "space-between",
      marginBottom: theme.space.medium
    },
    manualInput: {
      borderColor: theme.color.border,
      borderRadius: theme.radius.medium,
      borderWidth: StyleSheet.hairlineWidth,
      color: theme.color.text,
      fontSize: 15,
      minHeight: 52,
      paddingHorizontal: theme.space.medium,
      paddingVertical: theme.space.small
    },
    manualSheet: { gap: theme.space.medium, padding: theme.space.large },
    manualTitle: { color: theme.color.text, fontSize: 18, fontWeight: "700" },
    pressed: { opacity: 0.72 },
    statusPill: {
      alignItems: "center",
      backgroundColor: theme.color.panel,
      borderColor: theme.color.border,
      borderRadius: theme.radius.medium,
      borderWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      paddingHorizontal: theme.space.small,
      paddingVertical: 5
    },
    root: { backgroundColor: theme.color.background, flex: 1 }
  });
}
