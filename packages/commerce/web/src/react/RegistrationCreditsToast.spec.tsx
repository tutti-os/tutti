import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RegistrationCreditsToast } from "./RegistrationCreditsToast";

const labels = {
  title: "Welcome credits",
  creditsUnit: "credits",
  description: "Registration reward",
  close: "Close"
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("RegistrationCreditsToast", () => {
  it("does not render when the Host marks the reward as hidden", () => {
    render(
      <RegistrationCreditsToast
        toast={{
          id: "reward-1",
          creditsLabel: "100",
          visible: false,
          onDismiss: vi.fn()
        }}
        labels={labels}
      />
    );

    expect(
      screen.queryByTestId("commerce-registration-credits-toast")
    ).not.toBeInTheDocument();
  });

  it("supports explicit dismissal", () => {
    const onDismiss = vi.fn();
    render(
      <RegistrationCreditsToast
        toast={{
          id: "reward-1",
          creditsLabel: "100",
          visible: true,
          onDismiss
        }}
        labels={labels}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("uses the Host-provided auto-dismiss duration", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(
      <RegistrationCreditsToast
        toast={{
          id: "reward-1",
          creditsLabel: "100",
          visible: true,
          autoDismissMs: 1_000,
          onDismiss
        }}
        labels={labels}
      />
    );

    vi.advanceTimersByTime(999);
    expect(onDismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
