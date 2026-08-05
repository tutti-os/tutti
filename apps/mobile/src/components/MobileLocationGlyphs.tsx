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

export function MobileQRCodeGlyph({
  color,
  size = 20
}: {
  color: string;
  size?: number;
}) {
  const cornerSize = size * 0.38;
  const thickness = Math.max(1.5, size * 0.1);
  const dotSize = Math.max(3, size * 0.16);
  const cornerStyle = {
    borderColor: color,
    height: cornerSize,
    position: "absolute" as const,
    width: cornerSize
  };

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ height: size, width: size }}
    >
      <View
        style={[
          cornerStyle,
          {
            borderLeftWidth: thickness,
            borderTopLeftRadius: 2,
            borderTopWidth: thickness,
            left: 0,
            top: 0
          }
        ]}
      />
      <View
        style={[
          cornerStyle,
          {
            borderRightWidth: thickness,
            borderTopRightRadius: 2,
            borderTopWidth: thickness,
            right: 0,
            top: 0
          }
        ]}
      />
      <View
        style={[
          cornerStyle,
          {
            borderBottomLeftRadius: 2,
            borderBottomWidth: thickness,
            borderLeftWidth: thickness,
            bottom: 0,
            left: 0
          }
        ]}
      />
      <View
        style={[
          cornerStyle,
          {
            borderBottomRightRadius: 2,
            borderBottomWidth: thickness,
            borderRightWidth: thickness,
            bottom: 0,
            right: 0
          }
        ]}
      />
      <View
        style={{
          backgroundColor: color,
          borderRadius: 1,
          height: dotSize,
          left: (size - dotSize) / 2,
          position: "absolute",
          top: (size - dotSize) / 2,
          width: dotSize
        }}
      />
    </View>
  );
}

export function MobilePairingGlyph({
  color,
  size = 72
}: {
  color: string;
  size?: number;
}) {
  const innerSize = size * 0.68;
  const computerSize = size * 0.38;
  const linkWidth = size * 0.24;
  const linkHeight = Math.max(4, size * 0.07);

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        alignItems: "center",
        height: size,
        justifyContent: "center",
        width: size
      }}
    >
      <View
        style={[
          styles.pairingRing,
          {
            borderColor: color,
            borderRadius: size / 2,
            height: size,
            opacity: 0.12,
            width: size
          }
        ]}
      />
      <View
        style={[
          styles.pairingRing,
          {
            borderColor: color,
            borderRadius: innerSize / 2,
            height: innerSize,
            opacity: 0.16,
            width: innerSize
          }
        ]}
      />
      <View style={styles.pairingComputer}>
        <MobileComputerGlyph color={color} size={computerSize} />
        <View
          style={[
            styles.pairingLink,
            {
              backgroundColor: color,
              height: linkHeight,
              left: computerSize * 0.34,
              top: computerSize * 0.38,
              transform: [{ rotate: "-45deg" }],
              width: linkWidth
            }
          ]}
        />
        <View
          style={[
            styles.pairingLink,
            {
              backgroundColor: color,
              height: linkHeight,
              left: computerSize * 0.62,
              top: computerSize * 0.55,
              transform: [{ rotate: "-45deg" }],
              width: linkWidth
            }
          ]}
        />
      </View>
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
  },
  pairingComputer: {
    alignItems: "center",
    justifyContent: "center",
    position: "absolute"
  },
  pairingLink: {
    borderRadius: 4,
    position: "absolute"
  },
  pairingRing: {
    borderWidth: 1,
    position: "absolute"
  }
});
