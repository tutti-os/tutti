import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from "react-native";
import { PrimaryButton } from "../components/PrimaryButton";
import { t } from "../i18n";
import {
  deviceLink,
  mobileSecurity,
  type AccountSession
} from "../native/mobileNative";
import {
  claimPairing,
  connectPairedDevice,
  getPairingChallenge,
  listDevices,
  listPairings,
  parsePairingQR,
  registerCurrentDevice,
  type DevicePairing,
  type UserDevice
} from "../services/pairingClient";
import { theme } from "../theme";

interface DeviceScreenProps {
  onConnected(deviceName: string): void;
  onSignOut(): Promise<void>;
  session: AccountSession;
}

type PairingState = "idle" | "claiming" | "waiting" | "confirmed";

export function DeviceScreen({
  onConnected,
  onSignOut,
  session
}: DeviceScreenProps) {
  const [devices, setDevices] = useState<UserDevice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pairingState, setPairingState] = useState<PairingState>("idle");
  const [pairings, setPairings] = useState<DevicePairing[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [connectingPairingID, setConnectingPairingID] = useState<string | null>(
    null
  );
  const [manualPairingCode, setManualPairingCode] = useState("");
  const [manualPairingOpen, setManualPairingOpen] = useState(false);
  const pairingRun = useRef(0);
  const connectionRun = useRef(0);
  const scannerOpen = useRef(false);

  const refresh = useCallback(async () => {
    setError(null);
    setRefreshing(true);
    try {
      const [registered, nextPairings, nextDevices] = await Promise.all([
        registerCurrentDevice(session.sessionId),
        listPairings(session.sessionId),
        listDevices(session.sessionId)
      ]);
      setPairings(
        nextPairings.filter(
          (pairing) =>
            pairing.state === "active" &&
            pairing.controllerUserDeviceId === registered.userDeviceId
        )
      );
      setDevices(nextDevices);
    } catch (cause) {
      console.warn("[mobile-device-refresh] failed", {
        message: cause instanceof Error ? cause.message : String(cause),
        name: cause instanceof Error ? cause.name : "",
        status:
          typeof cause === "object" && cause !== null && "status" in cause
            ? String(cause.status)
            : ""
      });
      setError(t("genericError"));
    } finally {
      setRefreshing(false);
    }
  }, [session.sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active") {
        // A backgrounded app stops the in-flight pairing poll. Rehydrate the
        // list on resume so a pairing confirmed while we were suspended is
        // visible without requiring a process restart.
        void refresh();
        return;
      }
      connectionRun.current += 1;
      void deviceLink.closeLink().catch(() => undefined);
      setConnectingPairingID(null);
      if (!scannerOpen.current) {
        pairingRun.current += 1;
        setPairingState((current) =>
          current === "claiming" || current === "waiting" ? "idle" : current
        );
      }
    });
    return () => {
      pairingRun.current += 1;
      connectionRun.current += 1;
      subscription.remove();
    };
  }, [refresh]);

  const devicesByID = useMemo(
    () => new Map(devices.map((device) => [device.userDeviceId, device])),
    [devices]
  );

  const pair = async (manualPayload?: string) => {
    const run = ++pairingRun.current;
    setError(null);
    setPairingState("claiming");
    try {
      let rawPayload = manualPayload?.trim();
      if (!rawPayload) {
        scannerOpen.current = true;
        try {
          rawPayload = await mobileSecurity.scanQRCode();
        } finally {
          scannerOpen.current = false;
        }
      }
      const payload = parsePairingQR(rawPayload);
      if (run !== pairingRun.current) {
        return;
      }
      const challenge = await claimPairing(session.sessionId, payload);
      if (run !== pairingRun.current) {
        return;
      }
      setPairingState("waiting");
      const deadline = Date.parse(challenge.expiresAt);
      while (Date.now() < deadline) {
        await delay(1_000);
        if (run !== pairingRun.current) {
          return;
        }
        const latest = await getPairingChallenge(
          session.sessionId,
          payload.challengeId
        );
        if (latest.state === "confirmed") {
          if (run !== pairingRun.current) {
            return;
          }
          setPairingState("confirmed");
          setManualPairingCode("");
          setManualPairingOpen(false);
          await refresh();
          return;
        }
      }
      throw new Error("pairing challenge expired");
    } catch (cause) {
      const code =
        typeof cause === "object" && cause !== null && "code" in cause
          ? String(cause.code)
          : "";
      console.warn("[mobile-pairing] failed", {
        code,
        message: cause instanceof Error ? cause.message : String(cause),
        name: cause instanceof Error ? cause.name : "",
        status:
          typeof cause === "object" && cause !== null && "status" in cause
            ? String(cause.status)
            : ""
      });
      if (run !== pairingRun.current) {
        return;
      }
      if (code !== "SCAN_CANCELLED") {
        setError(
          code === "SCANNER_PERMISSION_DENIED"
            ? t("cameraPermissionRequired")
            : code === "SCANNER_UNAVAILABLE" || code === "SCAN_FAILED"
              ? t("scannerUnavailable")
              : t("pairingFailed")
        );
      }
      setPairingState("idle");
    }
  };

  const connect = async (pairing: DevicePairing, device?: UserDevice) => {
    if (connectingPairingID) {
      return;
    }
    const run = ++connectionRun.current;
    setConnectingPairingID(pairing.pairingId);
    setError(null);
    try {
      await connectPairedDevice(
        session.sessionId,
        pairing.pairingId,
        () => run === connectionRun.current
      );
      if (run !== connectionRun.current) {
        return;
      }
      onConnected(
        device?.displayName || device?.reportedName || t("desktopFallback")
      );
    } catch {
      if (run === connectionRun.current) {
        setError(t("connectionFailed"));
      }
    } finally {
      if (run === connectionRun.current) {
        setConnectingPairingID(null);
      }
    }
  };

  const status =
    pairingState === "waiting"
      ? t("pairingWaiting")
      : pairingState === "confirmed"
        ? t("pairingConfirmed")
        : null;

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <View>
          <Text style={styles.eyebrow}>{t("welcome")}</Text>
          <Text style={styles.title}>{t("devices")}</Text>
        </View>
        <PrimaryButton
          label={t("logout")}
          onPress={() => {
            connectionRun.current += 1;
            void onSignOut();
          }}
          secondary
          style={styles.logout}
        />
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            onRefresh={() => void refresh()}
            refreshing={refreshing}
            tintColor={theme.color.textSecondary}
          />
        }
      >
        {pairings.length === 0 && !refreshing ? (
          <View style={styles.empty}>
            <View style={styles.emptyIcon}>
              <Text style={styles.emptyIconText}>⌁</Text>
            </View>
            <Text style={styles.emptyTitle}>{t("deviceEmptyTitle")}</Text>
            <Text style={styles.emptyBody}>{t("deviceEmpty")}</Text>
          </View>
        ) : null}

        {pairings.map((pairing) => {
          const device = devicesByID.get(pairing.targetUserDeviceId);
          return (
            <Pressable
              disabled={connectingPairingID !== null}
              key={pairing.pairingId}
              onPress={() => void connect(pairing, device)}
              style={({ pressed }) => [
                styles.deviceCard,
                pressed && styles.deviceCardPressed
              ]}
            >
              <View style={styles.deviceMark}>
                <Text style={styles.deviceMarkText}>T</Text>
              </View>
              <View style={styles.deviceCopy}>
                <Text style={styles.deviceName}>
                  {device?.displayName ||
                    device?.reportedName ||
                    t("desktopFallback")}
                </Text>
                <Text style={styles.deviceMeta}>
                  {connectingPairingID === pairing.pairingId
                    ? t("connecting")
                    : `${device?.platform || "desktop"} · ${t("connected")}`}
                </Text>
              </View>
              {connectingPairingID === pairing.pairingId ? (
                <ActivityIndicator color={theme.color.accent} size="small" />
              ) : (
                <View style={styles.statusDot} />
              )}
            </Pressable>
          );
        })}

        {status ? (
          <View style={styles.status}>
            <ActivityIndicator color={theme.color.accent} size="small" />
            <Text style={styles.statusText}>{status}</Text>
          </View>
        ) : null}
      </ScrollView>

      <View style={styles.footer}>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <PrimaryButton
          label={
            pairingState === "claiming" || pairingState === "waiting"
              ? t("pairing")
              : t("pairAction")
          }
          loading={pairingState === "claiming"}
          disabled={pairingState !== "idle" && pairingState !== "confirmed"}
          onPress={() => void pair()}
        />
        {manualPairingOpen ? (
          <>
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              multiline
              onChangeText={setManualPairingCode}
              placeholder={t("pairingCodeHint")}
              placeholderTextColor={theme.color.muted}
              style={styles.manualInput}
              value={manualPairingCode}
            />
            <PrimaryButton
              disabled={!manualPairingCode.trim() || pairingState !== "idle"}
              label={t("pairingCodeSubmit")}
              onPress={() => void pair(manualPairingCode)}
              secondary
            />
          </>
        ) : (
          <PrimaryButton
            label={t("pairingCodeAction")}
            onPress={() => setManualPairingOpen(true)}
            secondary
          />
        )}
      </View>
    </View>
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const styles = StyleSheet.create({
  content: {
    flexGrow: 1,
    gap: theme.space.medium,
    padding: theme.space.large
  },
  deviceCard: {
    alignItems: "center",
    backgroundColor: theme.color.panel,
    borderColor: theme.color.border,
    borderRadius: theme.radius.large,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    padding: theme.space.medium
  },
  deviceCopy: {
    flex: 1,
    marginLeft: 14
  },
  deviceCardPressed: {
    opacity: 0.72
  },
  deviceMark: {
    alignItems: "center",
    backgroundColor: theme.color.panelRaised,
    borderRadius: theme.radius.medium,
    height: 48,
    justifyContent: "center",
    width: 48
  },
  deviceMarkText: {
    color: theme.color.text,
    fontSize: 20,
    fontWeight: "900"
  },
  manualInput: {
    borderColor: theme.color.border,
    borderRadius: theme.radius.medium,
    borderWidth: StyleSheet.hairlineWidth,
    color: theme.color.text,
    maxHeight: 120,
    minHeight: 72,
    padding: theme.space.small
  },
  deviceMeta: {
    color: theme.color.muted,
    fontSize: 13,
    marginTop: 4,
    textTransform: "capitalize"
  },
  deviceName: {
    color: theme.color.text,
    fontSize: 16,
    fontWeight: "700"
  },
  empty: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
    minHeight: 360,
    paddingHorizontal: theme.space.large
  },
  emptyBody: {
    color: theme.color.textSecondary,
    fontSize: 15,
    lineHeight: 23,
    marginTop: 10,
    textAlign: "center"
  },
  emptyIcon: {
    alignItems: "center",
    backgroundColor: theme.color.panel,
    borderColor: theme.color.border,
    borderRadius: 28,
    borderWidth: StyleSheet.hairlineWidth,
    height: 56,
    justifyContent: "center",
    marginBottom: 18,
    width: 56
  },
  emptyIconText: {
    color: theme.color.accent,
    fontSize: 28
  },
  emptyTitle: {
    color: theme.color.text,
    fontSize: 20,
    fontWeight: "700"
  },
  error: {
    color: theme.color.danger,
    fontSize: 13,
    lineHeight: 19,
    textAlign: "center"
  },
  eyebrow: {
    color: theme.color.accent,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.7,
    textTransform: "uppercase"
  },
  footer: {
    borderColor: theme.color.border,
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
  logout: {
    height: 40
  },
  root: {
    backgroundColor: theme.color.background,
    flex: 1
  },
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
  statusText: {
    color: theme.color.textSecondary,
    flex: 1,
    fontSize: 14,
    lineHeight: 20
  },
  title: {
    color: theme.color.text,
    fontSize: 28,
    fontWeight: "700",
    letterSpacing: -0.5,
    marginTop: 4
  }
});
