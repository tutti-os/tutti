import type { ReactNode } from "react";
import {
  StyleSheet,
  type GestureResponderEvent,
  type StyleProp,
  type ViewStyle
} from "react-native";
import { NativeButton, type ButtonSize, type ButtonVariant } from "./button";

export interface NativeIconButtonProps {
  accessibilityLabel: string;
  disabled?: boolean;
  icon: ReactNode;
  onPress(event: GestureResponderEvent): void;
  size?: Extract<ButtonSize, "compact" | "icon">;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  variant?: ButtonVariant;
}

export function NativeIconButton({
  accessibilityLabel,
  disabled = false,
  icon,
  onPress,
  size = "icon",
  style,
  testID,
  variant = "ghost"
}: NativeIconButtonProps) {
  return (
    <NativeButton
      accessibilityLabel={accessibilityLabel}
      disabled={disabled}
      label=""
      leading={icon}
      onPress={onPress}
      size={size}
      style={[styles.button, style]}
      testID={testID}
      variant={variant}
    />
  );
}

const styles = StyleSheet.create({
  button: { paddingHorizontal: 0 }
});
