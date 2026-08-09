import {
  NativeAvatar,
  NativeButton,
  NativeIconButton,
  NativeListRow,
  NativeSheet,
  type NativeTheme,
  useNativeTheme
} from "@tutti-os/ui-system/native";
import { useMemo, useState } from "react";
import { PanResponder, ScrollView, StyleSheet, Text, View } from "react-native";
import { t } from "../i18n";
import type { AccountSession } from "../services/mobileDomain";
import type { MobileThemePreference } from "../services/mobileThemePreferenceService";

export interface SettingsScreenViewProps {
  onBack(): void;
  onSoftwareUpdatePress(): void;
  onSignOut(): void;
  onThemePreferenceChange(preference: MobileThemePreference): void;
  session: AccountSession;
  softwareUpdateDescription: string;
  softwareUpdateDisabled: boolean;
  themePreference: MobileThemePreference;
}

export function SettingsScreenView({
  onBack,
  onSoftwareUpdatePress,
  onSignOut,
  onThemePreferenceChange,
  session,
  softwareUpdateDescription,
  softwareUpdateDisabled,
  themePreference
}: SettingsScreenViewProps) {
  const theme = useNativeTheme();
  const styles = createStyles(theme);
  const [themeSheetOpen, setThemeSheetOpen] = useState(false);
  const accountLabel = session.name || session.email || t("appName");
  const themeSheetPanResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, gestureState) =>
          gestureState.dy > 8 &&
          Math.abs(gestureState.dy) > Math.abs(gestureState.dx),
        onPanResponderRelease: (_, gestureState) => {
          if (shouldDismissThemeSheetSwipe(gestureState.dy)) {
            setThemeSheetOpen(false);
          }
        }
      }),
    []
  );

  const selectTheme = (preference: MobileThemePreference): void => {
    onThemePreferenceChange(preference);
    setThemeSheetOpen(false);
  };

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <NativeIconButton
          accessibilityLabel={t("back")}
          icon={<Text style={styles.backIcon}>‹</Text>}
          onPress={onBack}
        />
        <Text style={styles.title}>{t("settings")}</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.accountCard}>
          <NativeAvatar
            label={accountLabel}
            size="large"
            src={session.avatarURL}
          />
          <View style={styles.accountCopy}>
            <Text numberOfLines={1} style={styles.accountName}>
              {accountLabel}
            </Text>
            {session.email ? (
              <Text numberOfLines={1} style={styles.accountEmail}>
                {session.email}
              </Text>
            ) : null}
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t("app")}</Text>
          <View style={styles.listCard}>
            <NativeListRow
              onPress={() => setThemeSheetOpen(true)}
              title={t("theme")}
              trailing={
                <View style={styles.themeTrailing}>
                  <Text style={styles.themeValue}>
                    {themePreferenceLabel(themePreference)}
                  </Text>
                  <Text style={styles.chevron}>›</Text>
                </View>
              }
            />
            <View style={styles.separator} />
            <NativeListRow
              description={softwareUpdateDescription}
              disabled={softwareUpdateDisabled}
              onPress={onSoftwareUpdatePress}
              title={t("softwareUpdate")}
              trailing={<Text style={styles.chevron}>›</Text>}
            />
            <View style={styles.separator} />
            <NativeListRow
              description={t("aboutTuttiDescription")}
              title={t("aboutTutti")}
            />
          </View>
        </View>

        <NativeButton
          label={t("logout")}
          onPress={onSignOut}
          size="large"
          variant="destructiveGhost"
        />
      </ScrollView>

      <NativeSheet
        closeAccessibilityLabel={t("closeSheet")}
        onOpenChange={setThemeSheetOpen}
        open={themeSheetOpen}
      >
        <View
          {...themeSheetPanResponder.panHandlers}
          style={styles.themeSheet}
          testID="theme-selection-sheet"
        >
          <Text style={styles.themeSheetTitle}>{t("theme")}</Text>
          {(["system", "light", "dark"] as const).map((preference) => {
            const selected = preference === themePreference;
            return (
              <NativeListRow
                key={preference}
                onPress={() => selectTheme(preference)}
                selected={selected}
                title={themePreferenceLabel(preference)}
                trailing={
                  selected ? <Text style={styles.checkmark}>✓</Text> : undefined
                }
              />
            );
          })}
        </View>
      </NativeSheet>
    </View>
  );
}

export function shouldDismissThemeSheetSwipe(deltaY: number): boolean {
  return deltaY >= 48;
}

function themePreferenceLabel(preference: MobileThemePreference): string {
  switch (preference) {
    case "light":
      return t("themeLight");
    case "dark":
      return t("themeDark");
    default:
      return t("themeSystem");
  }
}

function createStyles(theme: NativeTheme) {
  return StyleSheet.create({
    accountCard: {
      alignItems: "center",
      backgroundColor: theme.color.panel,
      borderColor: theme.color.border,
      borderRadius: theme.radius.large,
      borderWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      padding: theme.space.medium
    },
    accountCopy: { flex: 1, marginLeft: theme.space.medium },
    accountEmail: {
      color: theme.color.muted,
      fontSize: theme.space.small + 3,
      marginTop: theme.space.small / 2
    },
    accountName: {
      color: theme.color.text,
      fontSize: theme.space.medium + 2,
      fontWeight: "700"
    },
    backIcon: {
      color: theme.color.text,
      fontSize: theme.space.xlarge,
      lineHeight: theme.control.icon
    },
    checkmark: {
      color: theme.color.accent,
      fontSize: theme.space.medium + 2,
      fontWeight: "700"
    },
    chevron: {
      color: theme.color.muted,
      fontSize: theme.space.large,
      lineHeight: theme.space.large
    },
    content: {
      gap: theme.space.xlarge,
      padding: theme.space.large
    },
    header: {
      alignItems: "center",
      borderBottomColor: theme.color.border,
      borderBottomWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      paddingHorizontal: theme.space.small,
      paddingVertical: theme.space.small / 2
    },
    headerSpacer: { height: theme.control.icon, width: theme.control.icon },
    listCard: {
      backgroundColor: theme.color.panel,
      borderColor: theme.color.border,
      borderRadius: theme.radius.large,
      borderWidth: StyleSheet.hairlineWidth,
      overflow: "hidden"
    },
    root: { backgroundColor: theme.color.background, flex: 1 },
    section: { gap: theme.space.small },
    sectionTitle: {
      color: theme.color.muted,
      fontSize: theme.space.small + 2,
      fontWeight: "700",
      paddingHorizontal: theme.space.small
    },
    separator: {
      backgroundColor: theme.color.border,
      height: StyleSheet.hairlineWidth,
      marginLeft: theme.space.medium
    },
    title: {
      color: theme.color.text,
      flex: 1,
      fontSize: theme.space.medium + 2,
      fontWeight: "700",
      textAlign: "center"
    },
    themeSheet: {
      minHeight: theme.control.row * 4,
      padding: theme.space.medium
    },
    themeSheetTitle: {
      color: theme.color.text,
      fontSize: theme.space.medium + 1,
      fontWeight: "700",
      marginBottom: theme.space.small
    },
    themeTrailing: {
      alignItems: "center",
      flexDirection: "row",
      gap: theme.space.small
    },
    themeValue: {
      color: theme.color.muted,
      fontSize: theme.space.medium - 2
    }
  });
}
