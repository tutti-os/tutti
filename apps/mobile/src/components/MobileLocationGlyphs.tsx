import { StyleSheet, View } from "react-native";

export function MobileComputerGlyph({
  color,
  size = 18
}: {
  color: string;
  size?: number;
}) {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ height: size, width: size + 4 }}
    >
      <View
        style={[
          styles.computerScreen,
          {
            borderColor: color,
            height: size - 5,
            width: size
          }
        ]}
      />
      <View
        style={[
          styles.computerBase,
          {
            backgroundColor: color,
            top: size - 3,
            width: size + 4
          }
        ]}
      />
    </View>
  );
}

export function MobileFolderGlyph({
  color,
  size = 20
}: {
  color: string;
  size?: number;
}) {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ height: size - 3, width: size }}
    >
      <View
        style={[
          styles.folderTab,
          {
            borderColor: color,
            height: Math.max(5, size * 0.32),
            width: size * 0.48
          }
        ]}
      />
      <View
        style={[
          styles.folderBody,
          {
            borderColor: color,
            height: size * 0.7,
            top: size * 0.22,
            width: size
          }
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  computerBase: {
    borderRadius: 2,
    height: 2,
    left: 0,
    position: "absolute"
  },
  computerScreen: {
    borderRadius: 3,
    borderWidth: 1.5,
    left: 2,
    position: "absolute",
    top: 0
  },
  folderBody: {
    borderRadius: 3,
    borderWidth: 1.5,
    left: 0,
    position: "absolute"
  },
  folderTab: {
    borderBottomWidth: 0,
    borderTopLeftRadius: 3,
    borderTopRightRadius: 3,
    borderWidth: 1.5,
    left: 2,
    position: "absolute",
    top: 0
  }
});
