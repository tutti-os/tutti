import type { ReactNode } from "react";
import {
  type DimensionValue,
  Modal,
  Pressable,
  StyleSheet
} from "react-native";
import { useNativeTheme } from "./theme-provider";

export interface NativeSheetProps {
  children: ReactNode;
  onOpenChange(open: boolean): void;
  open: boolean;
  snapPoints?: readonly (number | `${number}%`)[];
}

/**
 * Controlled sheet backed by React Native's window-level Modal.
 *
 * Callers own whether the sheet is open and what product actions its content
 * performs.
 */
export function NativeSheet({
  children,
  onOpenChange,
  open,
  snapPoints
}: NativeSheetProps) {
  const theme = useNativeTheme();
  const styles = createStyles(theme);
  const height = resolveSheetHeight(snapPoints);

  return (
    <Modal
      animationType="fade"
      onRequestClose={() => onOpenChange(false)}
      presentationStyle="overFullScreen"
      statusBarTranslucent
      transparent
      visible={open}
    >
      <Pressable
        accessible={false}
        onPress={() => onOpenChange(false)}
        style={styles.backdrop}
        testID="native-sheet-backdrop"
      >
        <Pressable
          onPress={(event) => event.stopPropagation()}
          style={[styles.sheet, height === null ? null : { height }]}
        >
          {children}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function resolveSheetHeight(
  snapPoints: NativeSheetProps["snapPoints"]
): DimensionValue | null {
  if (!snapPoints) return null;
  const first = snapPoints[0];
  return typeof first === "number" || typeof first === "string"
    ? (first as DimensionValue)
    : null;
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
