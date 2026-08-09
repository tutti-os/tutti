import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { useNativeTheme } from "./theme-provider";
import type { NativeTheme } from "./tokens";

export interface NativeProgressBarProps {
  accessibilityLabel: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  value: number | null;
}

/** Token-backed determinate or indeterminate progress for Native renderers. */
export function NativeProgressBar({
  accessibilityLabel,
  style,
  testID,
  value
}: NativeProgressBarProps) {
  const theme = useNativeTheme();
  const styles = createStyles(theme);
  const normalized = value === null ? null : Math.min(1, Math.max(0, value));
  const percent = normalized === null ? null : Math.round(normalized * 100);

  return (
    <View
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="progressbar"
      accessibilityValue={
        percent === null ? undefined : { max: 100, min: 0, now: percent }
      }
      style={[styles.track, style]}
      testID={testID}
    >
      <View
        style={[
          styles.fill,
          normalized === null
            ? styles.indeterminate
            : { width: `${percent ?? 0}%` }
        ]}
      />
    </View>
  );
}

function createStyles(theme: NativeTheme) {
  return StyleSheet.create({
    fill: {
      backgroundColor: theme.color.accent,
      borderRadius: theme.radius.small,
      height: "100%"
    },
    indeterminate: { alignSelf: "center", width: "35%" },
    track: {
      backgroundColor: theme.color.panelRaised,
      borderColor: theme.color.border,
      borderRadius: theme.radius.small,
      borderWidth: StyleSheet.hairlineWidth,
      height: theme.space.small,
      overflow: "hidden",
      width: "100%"
    }
  });
}
