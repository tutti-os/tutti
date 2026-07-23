import { useEffect, useState } from "react";
import { ActivityIndicator, StatusBar, StyleSheet, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { mobileSecurity, type AccountSession } from "./native/mobileNative";
import { DeviceScreen } from "./screens/DeviceScreen";
import { LoginScreen } from "./screens/LoginScreen";
import { theme } from "./theme";

export default function App() {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<AccountSession | null>(null);

  useEffect(() => {
    mobileSecurity
      .loadSession()
      .then(setSession)
      .finally(() => setLoading(false));
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
    await mobileSecurity.clearSession();
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
        ) : session ? (
          <DeviceScreen onSignOut={signOut} session={session} />
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
