import type { ReactNode } from "react";
import { Modal, Pressable, StyleSheet, View } from "react-native";
import { useNativeTheme } from "./theme-provider";

export interface NativeSheetProps {
  children: ReactNode;
  closeAccessibilityLabel: string;
  height?: number | `${number}%`;
  onOpenChange(open: boolean): void;
  open: boolean;
}

/**
 * Controlled sheet backed by React Native's window-level Modal.
 *
 * Callers own whether the sheet is open and what product actions its content
 * performs.
 */
export function NativeSheet({
  children,
  closeAccessibilityLabel,
  height,
  onOpenChange,
  open
}: NativeSheetProps) {
  const theme = useNativeTheme();
  const styles = createStyles(theme);
  const dismiss = () => onOpenChange(false);

  return (
    <Modal
      animationType="fade"
      onRequestClose={dismiss}
      presentationStyle="overFullScreen"
      statusBarTranslucent
      transparent
      visible={open}
    >
      <View
        accessible={false}
        onAccessibilityEscape={dismiss}
        style={styles.backdrop}
      >
        <Pressable
          accessibilityLabel={closeAccessibilityLabel}
          accessibilityRole="button"
          accessible
          onPress={dismiss}
          style={StyleSheet.absoluteFill}
          testID="native-sheet-backdrop"
        />
        <Pressable
          accessible={false}
          onPress={() => undefined}
          style={[styles.sheet, height === undefined ? null : { height }]}
          testID="native-sheet-panel"
        >
          {children}
        </Pressable>
      </View>
    </Modal>
  );
}

function createStyles(theme: ReturnType<typeof useNativeTheme>) {
  return StyleSheet.create({
    backdrop: {
      backgroundColor: theme.color.scrim,
      flex: 1,
      justifyContent: "flex-end"
    },
    sheet: {
      backgroundColor: theme.color.panelRaised,
      borderTopLeftRadius: theme.radius.large,
      borderTopRightRadius: theme.radius.large,
      maxHeight: "80%",
      overflow: "hidden"
    }
  });
}
