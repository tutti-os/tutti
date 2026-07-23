import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View
} from "react-native";
import { PrimaryButton } from "../components/PrimaryButton";
import { t } from "../i18n";
import { mobileSecurity, type AccountSession } from "../native/mobileNative";
import {
  claimPairing,
  getPairingChallenge,
  listDevices,
  listPairings,
  parsePairingQR,
  type DevicePairing,
  type UserDevice
} from "../services/pairingClient";
import { theme } from "../theme";

interface DeviceScreenProps {
  onSignOut(): Promise<void>;
  session: AccountSession;
}

type PairingState = "idle" | "claiming" | "waiting" | "confirmed";

export function DeviceScreen({ onSignOut, session }: DeviceScreenProps) {
  const [devices, setDevices] = useState<UserDevice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pairingState, setPairingState] = useState<PairingState>("idle");
  const [pairings, setPairings] = useState<DevicePairing[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const pairingRun = useRef(0);

  const refresh = useCallback(async () => {
    setError(null);
    setRefreshing(true);
    try {
      const [nextPairings, nextDevices] = await Promise.all([
        listPairings(session.sessionId),
        listDevices(session.sessionId)
      ]);
      setPairings(nextPairings.filter((pairing) => pairing.state === "active"));
      setDevices(nextDevices);
    } catch {
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
      if (nextState !== "active") {
        pairingRun.current += 1;
        setPairingState((current) =>
          current === "claiming" || current === "waiting" ? "idle" : current
        );
      }
    });
    return () => {
      pairingRun.current += 1;
      subscription.remove();
    };
  }, []);

  const devicesByID = useMemo(
    () => new Map(devices.map((device) => [device.userDeviceId, device])),
    [devices]
  );

  const pair = async () => {
    const run = ++pairingRun.current;
    setError(null);
    setPairingState("claiming");
    try {
      const payload = parsePairingQR(await mobileSecurity.scanQRCode());
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
      if (run !== pairingRun.current) {
        return;
      }
      if (code !== "SCAN_CANCELLED") {
        setError(
          code === "SCANNER_UNAVAILABLE" || code === "SCAN_FAILED"
            ? t("scannerUnavailable")
            : t("pairingFailed")
        );
      }
      setPairingState("idle");
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
          onPress={() => void onSignOut()}
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
            <View key={pairing.pairingId} style={styles.deviceCard}>
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
                  {device?.platform || "desktop"} · {t("connected")}
                </Text>
              </View>
              <View style={styles.statusDot} />
            </View>
          );
        })}

        {status ? (
          <View style={styles.status}>
            <ActivityIndicator color={theme.color.accent} size="small" />
            <Text style={styles.statusText}>{status}</Text>
          </View>
        ) : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </ScrollView>

      <View style={styles.footer}>
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
