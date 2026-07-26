import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NativeSheet } from "./sheet";

const nativeModal = vi.hoisted(() => ({
  onAccessibilityEscape: null as (() => void) | null,
  onRequestClose: null as (() => void) | null,
  panelStyle: null as unknown
}));

vi.mock("react-native", () => ({
  Modal: ({
    children,
    onRequestClose,
    visible
  }: {
    children: ReactNode;
    onRequestClose(): void;
    visible: boolean;
  }) => {
    nativeModal.onRequestClose = onRequestClose;
    return visible ? <div>{children}</div> : null;
  },
  Pressable: ({
    accessibilityLabel,
    accessibilityRole,
    accessible,
    children,
    onPress,
    style,
    testID
  }: {
    accessibilityLabel?: string;
    accessibilityRole?: "button";
    accessible?: boolean;
    children?: ReactNode;
    onPress(): void;
    style?: unknown;
    testID?: string;
  }) => {
    if (testID === "native-sheet-panel") {
      nativeModal.panelStyle = style;
    }
    return (
      <div
        aria-label={accessibilityLabel}
        data-accessible={String(accessible)}
        data-testid={testID}
        onClick={onPress}
        role={accessibilityRole}
      >
        {children}
      </div>
    );
  },
  StyleSheet: { create: (styles: unknown) => styles },
  View: ({
    accessible,
    children,
    onAccessibilityEscape
  }: {
    accessible?: boolean;
    children: ReactNode;
    onAccessibilityEscape?(): void;
  }) => {
    nativeModal.onAccessibilityEscape =
      onAccessibilityEscape ?? nativeModal.onAccessibilityEscape;
    return <div data-accessible={String(accessible)}>{children}</div>;
  }
}));

vi.mock("./theme-provider", () => ({
  useNativeTheme: () => ({
    color: {
      muted: "#000",
      panelRaised: "#fff",
      scrim: "rgba(0, 0, 0, 0.6)"
    },
    radius: { large: 12 },
    space: { small: 10 }
  })
}));

describe("NativeSheet", () => {
  beforeEach(() => {
    nativeModal.onAccessibilityEscape = null;
    nativeModal.onRequestClose = null;
    nativeModal.panelStyle = null;
  });

  it("renders its content only while open", () => {
    const { rerender } = render(
      <NativeSheet
        closeAccessibilityLabel="Close sheet"
        onOpenChange={() => undefined}
        open={false}
      >
        content
      </NativeSheet>
    );

    expect(screen.queryByText("content")).not.toBeInTheDocument();

    rerender(
      <NativeSheet
        closeAccessibilityLabel="Close sheet"
        onOpenChange={() => undefined}
        open
      >
        content
      </NativeSheet>
    );
    expect(screen.getByText("content")).toBeInTheDocument();

    rerender(
      <NativeSheet
        closeAccessibilityLabel="Close sheet"
        onOpenChange={() => undefined}
        open={false}
      >
        content
      </NativeSheet>
    );
    expect(screen.queryByText("content")).not.toBeInTheDocument();
  });

  it("reports backdrop and system dismissals to the controlled owner", () => {
    const onOpenChange = vi.fn();
    const { container } = render(
      <NativeSheet
        closeAccessibilityLabel="Close sheet"
        onOpenChange={onOpenChange}
        open
      >
        content
      </NativeSheet>
    );

    expect(
      container.querySelectorAll('[data-accessible="false"]')
    ).toHaveLength(2);

    fireEvent.click(screen.getByText("content"));
    expect(onOpenChange).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Close sheet"
      })
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);

    onOpenChange.mockClear();
    nativeModal.onAccessibilityEscape?.();
    expect(onOpenChange).toHaveBeenCalledWith(false);

    onOpenChange.mockClear();
    nativeModal.onRequestClose?.();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("applies one explicit fixed height", () => {
    render(
      <NativeSheet
        closeAccessibilityLabel="Close sheet"
        height="50%"
        onOpenChange={() => undefined}
        open
      >
        content
      </NativeSheet>
    );

    expect(nativeModal.panelStyle).toEqual(
      expect.arrayContaining([{ height: "50%" }])
    );
  });
});
