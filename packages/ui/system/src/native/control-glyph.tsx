import type { ReactNode } from "react";
import { View } from "react-native";

export type NativeControlGlyphVariant =
  | "add"
  | "back"
  | "chevron"
  | "send"
  | "status"
  | "stop";

interface NativeControlGlyphBaseProps {
  color: string;
  size?: number;
}

interface NativeGlyphRenderProps {
  color: string;
  size: number;
}

export type NativeControlGlyphProps = NativeControlGlyphBaseProps &
  (
    | {
        direction: "down" | "left" | "right" | "up";
        variant: "chevron";
      }
    | {
        direction?: never;
        variant: Exclude<NativeControlGlyphVariant, "chevron">;
      }
  );

export function NativeControlGlyph(props: NativeControlGlyphProps) {
  switch (props.variant) {
    case "add":
      return <AddGlyph color={props.color} size={props.size ?? 20} />;
    case "back":
      return <BackGlyph color={props.color} size={props.size ?? 20} />;
    case "chevron":
      return (
        <ChevronGlyph
          color={props.color}
          direction={props.direction}
          size={props.size ?? 18}
        />
      );
    case "send":
      return <SendGlyph color={props.color} size={props.size ?? 20} />;
    case "status":
      return <StatusGlyph color={props.color} size={props.size ?? 8} />;
    case "stop":
      return <StopGlyph color={props.color} size={props.size ?? 20} />;
  }
}

function AddGlyph({ color, size }: NativeGlyphRenderProps) {
  const stroke = Math.max(2, size * 0.1);
  return (
    <GlyphFrame size={size}>
      <View
        style={{
          backgroundColor: color,
          borderRadius: stroke / 2,
          height: stroke,
          left: size * 0.2,
          position: "absolute",
          top: (size - stroke) / 2,
          width: size * 0.6
        }}
      />
      <View
        style={{
          backgroundColor: color,
          borderRadius: stroke / 2,
          height: size * 0.6,
          left: (size - stroke) / 2,
          position: "absolute",
          top: size * 0.2,
          width: stroke
        }}
      />
    </GlyphFrame>
  );
}

function BackGlyph({ color, size }: NativeGlyphRenderProps) {
  const stroke = Math.max(2, size * 0.1);
  const wing = size * 0.38;
  return (
    <GlyphFrame size={size}>
      <View
        style={{
          backgroundColor: color,
          borderRadius: stroke / 2,
          height: stroke,
          left: size * 0.16,
          position: "absolute",
          top: (size - stroke) / 2,
          width: size * 0.68
        }}
      />
      <View
        style={{
          backgroundColor: color,
          borderRadius: stroke / 2,
          height: stroke,
          left: size * 0.14,
          position: "absolute",
          top: size * 0.34,
          transform: [{ rotate: "-45deg" }],
          width: wing
        }}
      />
      <View
        style={{
          backgroundColor: color,
          borderRadius: stroke / 2,
          height: stroke,
          left: size * 0.14,
          position: "absolute",
          top: size * 0.61,
          transform: [{ rotate: "45deg" }],
          width: wing
        }}
      />
    </GlyphFrame>
  );
}

function ChevronGlyph({
  color,
  direction,
  size
}: NativeGlyphRenderProps & {
  direction: "down" | "left" | "right" | "up";
}) {
  const stroke = Math.max(2, size * 0.11);
  const bar = size * 0.48;
  const transforms =
    direction === "down"
      ? (["45deg", "-45deg"] as const)
      : direction === "up"
        ? (["-45deg", "45deg"] as const)
        : direction === "right"
          ? (["45deg", "-45deg"] as const)
          : (["-45deg", "45deg"] as const);
  const vertical = direction === "left" || direction === "right";

  return (
    <GlyphFrame size={size}>
      <View
        style={{
          backgroundColor: color,
          borderRadius: stroke / 2,
          height: stroke,
          left: vertical ? size * 0.28 : size * 0.18,
          position: "absolute",
          top: vertical ? size * 0.34 : size * 0.42,
          transform: [{ rotate: transforms[0] }],
          width: bar
        }}
      />
      <View
        style={{
          backgroundColor: color,
          borderRadius: stroke / 2,
          height: stroke,
          left: vertical ? size * 0.28 : size * 0.48,
          position: "absolute",
          top: vertical ? size * 0.6 : size * 0.42,
          transform: [{ rotate: transforms[1] }],
          width: bar
        }}
      />
    </GlyphFrame>
  );
}

function SendGlyph({ color, size }: NativeGlyphRenderProps) {
  const stroke = Math.max(2, size * 0.1);
  return (
    <GlyphFrame size={size}>
      <View
        style={{
          backgroundColor: color,
          borderRadius: stroke / 2,
          height: size * 0.68,
          left: (size - stroke) / 2,
          position: "absolute",
          top: size * 0.2,
          width: stroke
        }}
      />
      <View
        style={{
          backgroundColor: color,
          borderRadius: stroke / 2,
          height: stroke,
          left: size * 0.28,
          position: "absolute",
          top: size * 0.26,
          transform: [{ rotate: "-45deg" }],
          width: size * 0.38
        }}
      />
      <View
        style={{
          backgroundColor: color,
          borderRadius: stroke / 2,
          height: stroke,
          left: size * 0.46,
          position: "absolute",
          top: size * 0.26,
          transform: [{ rotate: "45deg" }],
          width: size * 0.38
        }}
      />
    </GlyphFrame>
  );
}

function StatusGlyph({ color, size }: NativeGlyphRenderProps) {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        backgroundColor: color,
        borderRadius: size / 2,
        height: size,
        width: size
      }}
    />
  );
}

function StopGlyph({ color, size }: NativeGlyphRenderProps) {
  const square = size * 0.48;
  return (
    <GlyphFrame size={size}>
      <View
        style={{
          backgroundColor: color,
          borderRadius: Math.max(2, size * 0.08),
          height: square,
          left: (size - square) / 2,
          position: "absolute",
          top: (size - square) / 2,
          width: square
        }}
      />
    </GlyphFrame>
  );
}

function GlyphFrame({ children, size }: { children: ReactNode; size: number }) {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ height: size, width: size }}
    >
      {children}
    </View>
  );
}
