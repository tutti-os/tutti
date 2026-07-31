import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  DevSettings,
  StatusBar,
  StyleSheet,
  View
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { type NativeTheme, useNativeTheme } from "@tutti-os/ui-system/native";
import { useServiceSnapshot } from "./bindings/useServiceSnapshot";
import { MobileConnectionRecoveryOverlay } from "./components/MobileConnectionRecoveryOverlay";
import { MobileUIProviders } from "./components/MobileUIProviders";
import { NativeComponentGallery } from "./dev/NativeComponentGallery";
import { t } from "./i18n";
import "@tutti-os/ui-system/native.css";
import { mobileApplicationService } from "./mobileRuntime";
import { MobileNavigator } from "./navigation/MobileNavigator";

export default function App() {
  return (
    <MobileUIProviders>
      <AppContent />
    </MobileUIProviders>
  );
}

function AppContent() {
  const theme = useNativeTheme();
  const styles = createStyles(theme);
  const snapshot = useServiceSnapshot(mobileApplicationService);
  const [galleryOpen, setGalleryOpen] = useState(false);

  useEffect(() => {
    if (__DEV__) {
      DevSettings.addMenuItem(t("nativeGallery"), () => setGalleryOpen(true));
    }
  }, []);

  return (
    <>
      <StatusBar
        backgroundColor={theme.color.background}
        barStyle={theme.mode === "dark" ? "light-content" : "dark-content"}
      />
      <SafeAreaView edges={["top", "bottom"]} style={styles.safeArea}>
        <View style={styles.content}>
          {galleryOpen ? (
            <NativeComponentGallery onClose={() => setGalleryOpen(false)} />
          ) : snapshot.status === "bootstrapping" ? (
            <View style={styles.loading}>
              <ActivityIndicator color={theme.color.accent} size="large" />
            </View>
          ) : (
            <MobileNavigator
              application={mobileApplicationService}
              snapshot={snapshot}
            />
          )}
          {snapshot.status === "authenticated" &&
          snapshot.device &&
          snapshot.workspace ? (
            <MobileConnectionRecoveryOverlay
              connection={snapshot.connection}
              onBackToDevices={() =>
                void mobileApplicationService.disconnectDevice()
              }
              onRetry={() =>
                void mobileApplicationService.retryDeviceConnection()
              }
            />
          ) : null}
        </View>
      </SafeAreaView>
    </>
  );
}

function createStyles(theme: NativeTheme) {
  return StyleSheet.create({
    content: { flex: 1 },
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
}
