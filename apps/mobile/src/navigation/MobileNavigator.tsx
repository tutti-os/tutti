import {
  DarkTheme,
  DefaultTheme,
  NavigationContainer,
  type Theme
} from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { useNativeTheme } from "@tutti-os/ui-system/native";
import type {
  MobileApplicationService,
  MobileApplicationSnapshot
} from "../services/mobileApplicationService";
import { ConversationScreen } from "../screens/ConversationScreen";
import { ConversationsScreen } from "../screens/ConversationsScreen";
import { DeviceScreen } from "../screens/DeviceScreen";
import { LoginScreen } from "../screens/LoginScreen";
import {
  availableMobileRoutes,
  type MobileRootStackParamList
} from "./mobileNavigation";

const Stack = createNativeStackNavigator<MobileRootStackParamList>();

export function MobileNavigator({
  application,
  snapshot
}: {
  application: MobileApplicationService;
  snapshot: Exclude<MobileApplicationSnapshot, { status: "bootstrapping" }>;
}) {
  const theme = useNativeTheme();
  const availableRoutes = availableMobileRoutes(snapshot);
  const navigationTheme: Theme = {
    ...(theme.mode === "dark" ? DarkTheme : DefaultTheme),
    colors: {
      ...(theme.mode === "dark" ? DarkTheme.colors : DefaultTheme.colors),
      background: theme.color.background,
      border: theme.color.border,
      card: theme.color.panel,
      notification: theme.color.danger,
      primary: theme.color.accent,
      text: theme.color.text
    }
  };

  return (
    <NavigationContainer theme={navigationTheme}>
      <Stack.Navigator
        screenOptions={{
          contentStyle: { backgroundColor: theme.color.background },
          headerShown: false
        }}
      >
        {snapshot.status === "unauthenticated" ? (
          <Stack.Group navigationKey="unauthenticated">
            <Stack.Screen name="Login">
              {() => <LoginScreen service={application.loginService!} />}
            </Stack.Screen>
          </Stack.Group>
        ) : (
          <Stack.Group navigationKey={`account:${snapshot.session.userId}`}>
            <Stack.Screen name="Devices">
              {(props) => <DeviceScreen {...props} application={application} />}
            </Stack.Screen>
            {availableRoutes.includes("Conversations") ? (
              <>
                <Stack.Screen name="Conversations">
                  {(props) => (
                    <ConversationsScreen {...props} application={application} />
                  )}
                </Stack.Screen>
                <Stack.Screen name="Conversation">
                  {(props) => (
                    <ConversationScreen {...props} application={application} />
                  )}
                </Stack.Screen>
              </>
            ) : null}
          </Stack.Group>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
