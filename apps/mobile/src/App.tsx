import { useEffect, useState } from "react";
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
import { DeviceScreen } from "./screens/DeviceScreen";
import { LoginScreen } from "./screens/LoginScreen";
import { WorkspaceScreen } from "./screens/WorkspaceScreen";
import { theme } from "./theme";

export default function App() {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<AccountSession | null>(null);
  const [connectedDevice, setConnectedDevice] = useState<string | null>(null);

  useEffect(() => {
    mobileSecurity
      .loadSession()
      .then(setSession)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    let disconnectTimer: ReturnType<typeof setTimeout> | undefined;
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active") {
        if (disconnectTimer) {
          clearTimeout(disconnectTimer);
          disconnectTimer = undefined;
        }
        return;
      }
      disconnectTimer = setTimeout(() => {
        void deviceLink.closeLink();
        setConnectedDevice(null);
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
