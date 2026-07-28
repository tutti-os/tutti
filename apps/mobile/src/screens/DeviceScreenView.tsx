import { useMemo } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from "react-native";
import { type NativeTheme, useNativeTheme } from "@tutti-os/ui-system/native";
import { PrimaryButton } from "../components/PrimaryButton";
import { t } from "../i18n";
import type { DeviceSnapshot } from "../services/deviceService";
import type { DevicePairing, UserDevice } from "../services/mobileDomain";

export interface DeviceScreenViewProps {
  accountName: string;
  manualPairingCode: string;
  manualPairingOpen: boolean;
  model: DeviceSnapshot;
  onConnect(pairing: DevicePairing, device?: UserDevice): void;
  onManualPairingCodeChange(value: string): void;
  onManualPairingOpen(): void;
  onManualPairingSubmit(): void;
  onRefresh(): void;
  onScanPairingCode(): void;
  onSignOut(): void;
}

export function DeviceScreenView({
  accountName,
  manualPairingCode,
  manualPairingOpen,
  model,
  onConnect,
  onManualPairingCodeChange,
  onManualPairingOpen,
  onManualPairingSubmit,
  onRefresh,
  onScanPairingCode,
  onSignOut
}: DeviceScreenViewProps) {
  const theme = useNativeTheme();
  const styles = createStyles(theme);
  const devicesById = useMemo(
    () => new Map(model.devices.map((device) => [device.userDeviceId, device])),
    [model.devices]
  );
  const status =
    model.pairingState === "waiting"
      ? t("pairingWaiting")
      : model.pairingState === "confirmed"
        ? t("pairingConfirmed")
        : null;
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

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <View>
          <Text style={styles.eyebrow}>{accountName || t("welcome")}</Text>
          <Text style={styles.title}>{t("devices")}</Text>
        </View>
        <PrimaryButton
          label={t("logout")}
          onPress={onSignOut}
          secondary
          size="compact"
        />
      </View>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            onRefresh={onRefresh}
            refreshing={model.refreshing}
            tintColor={theme.color.textSecondary}
          />
        }
      >
        {model.pairings.length === 0 && !model.refreshing ? (
          <View style={styles.empty}>
            <Text style={styles.emptyIcon}>⌁</Text>
            <Text style={styles.emptyTitle}>{t("deviceEmptyTitle")}</Text>
            <Text style={styles.emptyBody}>{t("deviceEmpty")}</Text>
          </View>
        ) : null}
        {model.pairings.map((pairing) => {
          const device = devicesById.get(pairing.targetUserDeviceId);
          const connecting = model.connectingPairingId === pairing.pairingId;
          return (
            <Pressable
              disabled={model.connectingPairingId !== null}
              key={pairing.pairingId}
              onPress={() => onConnect(pairing, device)}
              style={({ pressed }) => [styles.card, pressed && styles.pressed]}
            >
              <View style={styles.mark}>
                <Text style={styles.markText}>T</Text>
              </View>
              <View style={styles.cardCopy}>
                <Text style={styles.deviceName}>
                  {device?.displayName ||
                    device?.reportedName ||
                    t("desktopFallback")}
                </Text>
                <Text style={styles.deviceMeta}>
                  {connecting
                    ? t("connecting")
                    : `${device?.platform || t("desktopFallback")} · ${t("connected")}`}
                </Text>
              </View>
              {connecting ? (
                <ActivityIndicator color={theme.color.accent} size="small" />
              ) : (
                <View style={styles.statusDot} />
              )}
            </Pressable>
          );
        })}
        {status ? (
          <View style={styles.status}>
            {model.pairingState === "waiting" ? (
              <ActivityIndicator color={theme.color.accent} size="small" />
            ) : (
              <View style={styles.statusDot} />
            )}
            <Text style={styles.statusText}>{status}</Text>
          </View>
        ) : null}
      </ScrollView>
      <View style={styles.footer}>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <PrimaryButton
          disabled={
            model.pairingState !== "idle" && model.pairingState !== "confirmed"
          }
          label={
            model.pairingState === "claiming" ||
            model.pairingState === "waiting" ||
            model.pairingState === "scanning"
              ? t("pairing")
              : t("pairAction")
          }
          loading={
            model.pairingState === "claiming" ||
            model.pairingState === "scanning"
          }
          onPress={onScanPairingCode}
        />
        {manualPairingOpen ? (
          <>
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              multiline
              onChangeText={onManualPairingCodeChange}
              placeholder={t("pairingCodeHint")}
              placeholderTextColor={theme.color.muted}
              style={styles.manualInput}
              value={manualPairingCode}
            />
            <PrimaryButton
              disabled={
                !manualPairingCode.trim() ||
                (model.pairingState !== "idle" &&
                  model.pairingState !== "confirmed")
              }
              label={t("pairingCodeSubmit")}
              onPress={onManualPairingSubmit}
              secondary
            />
          </>
        ) : (
          <PrimaryButton
            label={t("pairingCodeAction")}
            onPress={onManualPairingOpen}
            secondary
          />
        )}
      </View>
    </View>
  );
}

function createStyles(theme: NativeTheme) {
  return StyleSheet.create({
    card: {
      alignItems: "center",
      backgroundColor: theme.color.panel,
      borderColor: theme.color.border,
      borderRadius: theme.radius.large,
      borderWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      padding: theme.space.medium
    },
    cardCopy: { flex: 1, marginLeft: 14 },
    content: {
      flexGrow: 1,
      gap: theme.space.medium,
      padding: theme.space.large
    },
    deviceMeta: { color: theme.color.muted, fontSize: 13, marginTop: 4 },
    deviceName: { color: theme.color.text, fontSize: 16, fontWeight: "700" },
    empty: {
      alignItems: "center",
      flex: 1,
      justifyContent: "center",
      minHeight: 360
    },
    emptyBody: {
      color: theme.color.textSecondary,
      fontSize: 15,
      lineHeight: 23,
      marginTop: 10,
      textAlign: "center"
    },
    emptyIcon: { color: theme.color.accent, fontSize: 36, marginBottom: 16 },
    emptyTitle: { color: theme.color.text, fontSize: 20, fontWeight: "700" },
    error: { color: theme.color.danger, fontSize: 13, textAlign: "center" },
    eyebrow: { color: theme.color.accent, fontSize: 12, fontWeight: "700" },
    footer: {
      borderTopColor: theme.color.border,
      borderTopWidth: StyleSheet.hairlineWidth,
      gap: theme.space.small,
      padding: theme.space.large
    },
    header: {
      alignItems: "center",
      borderBottomColor: theme.color.border,
      borderBottomWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      justifyContent: "space-between",
      padding: theme.space.large
    },
    manualInput: {
      borderColor: theme.color.border,
      borderRadius: theme.radius.medium,
      borderWidth: StyleSheet.hairlineWidth,
      color: theme.color.text,
      minHeight: 72,
      padding: theme.space.small
    },
    mark: {
      alignItems: "center",
      backgroundColor: theme.color.panelRaised,
      borderRadius: theme.radius.medium,
      height: 48,
      justifyContent: "center",
      width: 48
    },
    markText: { color: theme.color.text, fontSize: 20, fontWeight: "900" },
    pressed: { opacity: 0.72 },
    root: { backgroundColor: theme.color.background, flex: 1 },
    status: {
      alignItems: "center",
      backgroundColor: theme.color.panel,
      borderRadius: theme.radius.medium,
      flexDirection: "row",
      gap: theme.space.small,
      padding: theme.space.medium
    },
    statusDot: {
      backgroundColor: theme.color.success,
      borderRadius: 5,
      height: 10,
      width: 10
    },
    statusText: { color: theme.color.textSecondary, flex: 1, fontSize: 14 },
    title: {
      color: theme.color.text,
      fontSize: 28,
      fontWeight: "700",
      marginTop: 4
    }
  });
}
