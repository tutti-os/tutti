import { NativeButton, type ButtonSize } from "@tutti-os/ui-system/native";
import type { StyleProp, ViewStyle } from "react-native";

interface PrimaryButtonProps {
  disabled?: boolean;
  label: string;
  loading?: boolean;
  onPress(): void;
  secondary?: boolean;
  size?: Exclude<ButtonSize, "icon">;
  style?: StyleProp<ViewStyle>;
}

export function PrimaryButton({
  disabled = false,
  label,
  loading = false,
  onPress,
  secondary = false,
  size = "large",
  style
}: PrimaryButtonProps) {
  return (
    <NativeButton
      disabled={disabled}
      label={label}
      loading={loading}
      onPress={onPress}
      size={size}
      style={style}
      variant={secondary ? "secondary" : "primary"}
    />
  );
}
