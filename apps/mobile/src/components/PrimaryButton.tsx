import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  type StyleProp,
  type ViewStyle
} from "react-native";
import { theme } from "../theme";

interface PrimaryButtonProps {
  disabled?: boolean;
  label: string;
  loading?: boolean;
  onPress(): void;
  secondary?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function PrimaryButton({
  disabled = false,
  label,
  loading = false,
  onPress,
  secondary = false,
  style
}: PrimaryButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled || loading}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        secondary ? styles.secondary : styles.primary,
        pressed && !disabled ? styles.pressed : null,
        disabled ? styles.disabled : null,
        style
      ]}
    >
      {loading ? (
        <ActivityIndicator color={secondary ? theme.color.text : "#111216"} />
      ) : (
        <Text style={[styles.label, secondary ? styles.secondaryLabel : null]}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: "center",
    borderRadius: theme.radius.medium,
    height: 52,
    justifyContent: "center",
    paddingHorizontal: theme.space.medium
  },
  disabled: {
    opacity: 0.45
  },
  label: {
    color: "#111216",
    fontSize: 16,
    fontWeight: "700"
  },
  pressed: {
    opacity: 0.82
  },
  primary: {
    backgroundColor: theme.color.accent
  },
  secondary: {
    backgroundColor: theme.color.panelRaised,
    borderColor: theme.color.border,
    borderWidth: StyleSheet.hairlineWidth
  },
  secondaryLabel: {
    color: theme.color.text
  }
});
