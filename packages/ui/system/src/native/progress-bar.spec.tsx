import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { NativeProgressBar } from "./progress-bar";

vi.mock("react-native", () => ({
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  View: ({
    accessibilityLabel,
    accessibilityRole,
    accessibilityValue,
    children,
    testID
  }: {
    accessibilityLabel?: string;
    accessibilityRole?: string;
    accessibilityValue?: { now?: number };
    children?: ReactNode;
    testID?: string;
  }) => (
    <div
      aria-label={accessibilityLabel}
      aria-valuenow={accessibilityValue?.now}
      data-testid={testID}
      role={accessibilityRole}
    >
      {children}
    </div>
  )
}));

vi.mock("./theme-provider", () => ({
  useNativeTheme: () => ({
    color: { accent: "#000", border: "#000", panelRaised: "#fff" },
    radius: { small: 4 },
    space: { small: 8 }
  })
}));

describe("NativeProgressBar", () => {
  it("clamps determinate progress for accessibility", () => {
    render(
      <NativeProgressBar
        accessibilityLabel="Download progress"
        testID="progress"
        value={1.5}
      />
    );

    expect(
      screen.getByRole("progressbar", { name: "Download progress" })
    ).toHaveAttribute("aria-valuenow", "100");
  });

  it("supports indeterminate progress", () => {
    render(<NativeProgressBar accessibilityLabel="Verifying" value={null} />);

    expect(
      screen.getByRole("progressbar", { name: "Verifying" })
    ).not.toHaveAttribute("aria-valuenow");
  });
});
