import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  StatusBar,
  StyleSheet,
  View
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import {
  deviceLink,
  mobileSecurity,
  type AccountSession
} from "./native/mobileNative";
import { accountBaseURL } from "./config";
import { DeviceScreen } from "./screens/DeviceScreen";
import { LoginScreen } from "./screens/LoginScreen";
import { WorkspaceScreen } from "./screens/WorkspaceScreen";
import { theme } from "./theme";

export default function App() {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<AccountSession | null>(null);
  const [connectedDevice, setConnectedDevice] = useState<string | null>(null);
  const backgroundedAt = useRef<number | null>(null);

  useEffect(() => {
    mobileSecurity
      .loadSession()
      .then(async (storedSession) => {
        if (storedSession) {
          await mobileSecurity.installSessionCookie(
            accountBaseURL,
            storedSession.sessionId
          );
        }
        setSession(storedSession);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    let disconnectTimer: ReturnType<typeof setTimeout> | undefined;
    const disconnect = () => {
      backgroundedAt.current = null;
      void deviceLink.closeLink();
      setConnectedDevice(null);
    };
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active") {
        if (disconnectTimer) {
          clearTimeout(disconnectTimer);
          disconnectTimer = undefined;
        }
        if (
          backgroundedAt.current !== null &&
          Date.now() - backgroundedAt.current >= 15_000
        ) {
          disconnect();
        } else {
          backgroundedAt.current = null;
        }
        return;
      }
      if (backgroundedAt.current !== null) {
        return;
      }
      backgroundedAt.current = Date.now();
      disconnectTimer = setTimeout(() => {
        disconnectTimer = undefined;
        disconnect();
      }, 15_000);
    });
    return () => {
      if (disconnectTimer) {
        clearTimeout(disconnectTimer);
      }
      subscription.remove();
    };
  }, []);

  const signedIn = async (nextSession: AccountSession) => {
    await mobileSecurity.saveSession(
      nextSession.sessionId,
      nextSession.userId,
      nextSession.email,
      nextSession.name
    );
    setSession(nextSession);
  };

  const signOut = async () => {
    await deviceLink.closeLink().catch(() => undefined);
    await mobileSecurity.clearSession();
    await mobileSecurity
      .clearSessionCookie(accountBaseURL)
      .catch(() => undefined);
    setConnectedDevice(null);
    setSession(null);
  };

  return (
    <SafeAreaProvider>
      <StatusBar
        backgroundColor={theme.color.background}
        barStyle="light-content"
      />
      <SafeAreaView edges={["top", "bottom"]} style={styles.safeArea}>
        {loading ? (
          <View style={styles.loading}>
            <ActivityIndicator color={theme.color.accent} size="large" />
          </View>
        ) : session && connectedDevice ? (
          <WorkspaceScreen
            deviceName={connectedDevice}
            onDisconnect={async () => {
              await deviceLink.closeLink().catch(() => undefined);
              setConnectedDevice(null);
            }}
          />
        ) : session ? (
          <DeviceScreen
            onConnected={setConnectedDevice}
            onSignOut={signOut}
            session={session}
          />
        ) : (
          <LoginScreen onSignedIn={signedIn} />
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  loading: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center"
  },
  safeArea: {
    backgroundColor: theme.color.background,
    flex: 1
  }
});
