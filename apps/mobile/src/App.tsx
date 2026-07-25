import { ActivityIndicator, StatusBar, StyleSheet, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { useServiceSnapshot } from "./bindings/useServiceSnapshot";
import { mobileApplicationService } from "./mobileRuntime";
import { DeviceScreen } from "./screens/DeviceScreen";
import { LoginScreen } from "./screens/LoginScreen";
import { WorkspaceScreen } from "./screens/WorkspaceScreen";
import { theme } from "./theme";

export default function App() {
  const snapshot = useServiceSnapshot(mobileApplicationService);

  return (
    <SafeAreaProvider>
      <StatusBar
        backgroundColor={theme.color.background}
        barStyle="light-content"
      />
      <SafeAreaView edges={["top", "bottom"]} style={styles.safeArea}>
        {snapshot.route === "bootstrapping" ? (
          <View style={styles.loading}>
            <ActivityIndicator color={theme.color.accent} size="large" />
          </View>
        ) : snapshot.route === "login" ? (
          <LoginScreen service={mobileApplicationService.loginService!} />
        ) : snapshot.route === "devices" ? (
          <DeviceScreen
            onSignOut={() => mobileApplicationService.signOut()}
            service={mobileApplicationService.deviceService!}
            session={snapshot.session}
          />
        ) : (
          <WorkspaceScreen
            application={mobileApplicationService}
            device={snapshot.device}
            workspace={
              snapshot.route === "workspace" ? snapshot.workspace : null
            }
          />
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
