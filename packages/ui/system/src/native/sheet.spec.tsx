import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NativeSheet } from "./sheet";

const nativeModal = vi.hoisted(() => ({
  onRequestClose: null as (() => void) | null
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
    accessible,
    children,
    onPress,
    testID
  }: {
    accessible?: boolean;
    children: ReactNode;
    onPress(event: { stopPropagation(): void }): void;
    testID?: string;
  }) => (
    <div
      data-accessible={String(accessible)}
      data-testid={testID}
      onClick={(event) =>
        onPress({ stopPropagation: () => event.stopPropagation() })
      }
    >
      {children}
    </div>
  ),
  StyleSheet: { create: (styles: unknown) => styles },
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>
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
    nativeModal.onRequestClose = null;
  });

  it("renders its content only while open", () => {
    const { rerender } = render(
      <NativeSheet onOpenChange={() => undefined} open={false}>
        content
      </NativeSheet>
    );

    expect(screen.queryByText("content")).not.toBeInTheDocument();

    rerender(
      <NativeSheet onOpenChange={() => undefined} open>
        content
      </NativeSheet>
    );
    expect(screen.getByText("content")).toBeInTheDocument();

    rerender(
      <NativeSheet onOpenChange={() => undefined} open={false}>
        content
      </NativeSheet>
    );
    expect(screen.queryByText("content")).not.toBeInTheDocument();
  });

  it("reports backdrop and system dismissals to the controlled owner", () => {
    const onOpenChange = vi.fn();
    const { container } = render(
      <NativeSheet onOpenChange={onOpenChange} open>
        content
      </NativeSheet>
    );

    expect(
      container.querySelectorAll('[data-accessible="false"]')
    ).toHaveLength(2);

    fireEvent.click(screen.getByText("content"));
    expect(onOpenChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("native-sheet-backdrop"));
    expect(onOpenChange).toHaveBeenCalledWith(false);

    onOpenChange.mockClear();
    nativeModal.onRequestClose?.();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
