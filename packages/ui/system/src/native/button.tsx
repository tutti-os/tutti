import { type ReactNode, useState } from "react";
import {
  ActivityIndicator,
  type GestureResponderEvent,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle
} from "react-native";
import { type NativeTheme } from "./tokens";
import { useNativeTheme } from "./theme-provider";

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "destructive"
  | "destructiveGhost"
  | "ghost";

export type ButtonSize = "regular" | "large" | "compact" | "icon";

export interface NativeButtonProps {
  accessibilityLabel?: string;
  disabled?: boolean;
  label: string;
  leading?: ReactNode;
  loading?: boolean;
  onPress(event: GestureResponderEvent): void;
  size?: ButtonSize;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  variant?: ButtonVariant;
}

/**
 * Native counterpart of the UI System Button contract.
 *
 * Its interaction hierarchy is adapted from React Native Reusables' Button,
 * while the styling is deliberately token-backed and platform-native.
 */
export function NativeButton({
  accessibilityLabel,
  disabled = false,
  label,
  leading,
  loading = false,
  onPress,
  size = "regular",
  style,
  testID,
  variant = "primary"
}: NativeButtonProps) {
  const theme = useNativeTheme();
  const styles = createStyles(theme);
  const [pressed, setPressed] = useState(false);
  const unavailable = disabled || loading;
  const foreground = textColorByVariant(theme)[variant];
  const hasLabel = label.trim().length > 0;

  return (
    <Pressable
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityRole="button"
      accessibilityState={{ busy: loading, disabled: unavailable }}
      disabled={unavailable}
      onPress={onPress}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      style={[
        styles.button,
        styles[size],
        variantStyles(theme)[variant],
        pressed && !unavailable ? styles.pressed : undefined,
        unavailable ? styles.disabled : undefined,
        style
      ]}
      testID={testID}
    >
      <View style={styles.content}>
        {loading ? (
          <ActivityIndicator color={foreground} size="small" />
        ) : (
          <>
            {leading ? (
              <View style={[styles.leading, !hasLabel && styles.leadingOnly]}>
                {leading}
              </View>
            ) : null}
            {hasLabel ? (
              <Text
                numberOfLines={1}
                style={[styles.label, { color: foreground }]}
              >
                {label}
              </Text>
            ) : null}
          </>
        )}
      </View>
    </Pressable>
  );
}

function textColorByVariant(theme: NativeTheme): Record<ButtonVariant, string> {
  return {
    primary: theme.color.background,
    secondary: theme.color.text,
    destructive: theme.color.background,
    destructiveGhost: theme.color.danger,
    ghost: theme.color.text
  };
}

function variantStyles(theme: NativeTheme): Record<ButtonVariant, ViewStyle> {
  return {
    primary: { backgroundColor: theme.color.accent },
    secondary: {
      backgroundColor: theme.color.panelRaised,
      borderColor: theme.color.border,
      borderWidth: StyleSheet.hairlineWidth
    },
    destructive: { backgroundColor: theme.color.danger },
    destructiveGhost: { backgroundColor: "transparent" },
    ghost: { backgroundColor: "transparent" }
  };
}

function createStyles(theme: NativeTheme) {
  return StyleSheet.create({
    button: {
      alignItems: "center",
      borderRadius: theme.radius.medium,
      justifyContent: "center"
    },
    compact: {
      minHeight: theme.control.compact,
      paddingHorizontal: theme.space.small
    },
    content: {
      alignItems: "center",
      flexDirection: "row",
      justifyContent: "center"
    },
    disabled: { opacity: 0.45 },
    icon: {
      height: theme.control.icon,
      paddingHorizontal: 0,
      width: theme.control.icon
    },
    label: { fontSize: theme.space.medium, fontWeight: "700" },
    large: {
      minHeight: theme.control.large,
      paddingHorizontal: theme.space.medium
    },
    leading: { marginRight: theme.space.small },
    leadingOnly: { marginRight: 0 },
    pressed: { opacity: 0.82 },
    regular: {
      minHeight: theme.control.regular,
      paddingHorizontal: theme.space.medium
    }
  });
}
