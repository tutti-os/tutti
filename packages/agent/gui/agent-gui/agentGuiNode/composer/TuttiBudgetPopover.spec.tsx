import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TuttiBudgetPopover } from "./TuttiBudgetPopover";

const labels = {
  title: "Tutti orchestration",
  intensityLabel: "Orchestration intensity",
  intensityMin: "Minimal",
  intensityMax: "Maximal",
  confirm: "Confirm",
  cancel: "Cancel"
};

function renderPopover({ intensity = 50 } = {}) {
  const onConfirm = vi.fn();
  render(
    <TuttiBudgetPopover
      intensity={intensity}
      labels={labels}
      onConfirm={onConfirm}
    >
      <button type="button">Tutti</button>
    </TuttiBudgetPopover>
  );
  return { onConfirm };
}

function openPopover() {
  fireEvent.click(screen.getByRole("button", { name: "Tutti" }));
  return screen.getByText("Tutti orchestration");
}

describe("TuttiBudgetPopover", () => {
  it("opens on badge click with a slider seeded from the effective intensity", () => {
    renderPopover({ intensity: 62 });
    expect(screen.queryByText("Tutti orchestration")).toBeNull();

    openPopover();

    expect(
      screen.getByRole("slider", { name: "Orchestration intensity" })
    ).toHaveAttribute("aria-valuenow", "62");
    expect(screen.getByText("Minimal")).toBeInTheDocument();
    expect(screen.getByText("Maximal")).toBeInTheDocument();
  });

  it("cancel closes without committing the draft", () => {
    const { onConfirm } = renderPopover();
    openPopover();

    fireEvent.keyDown(
      screen.getByRole("slider", { name: "Orchestration intensity" }),
      { key: "ArrowRight" }
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByText("Tutti orchestration")).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("confirm commits the edited draft value and closes", () => {
    const { onConfirm } = renderPopover({ intensity: 50 });
    openPopover();

    fireEvent.keyDown(
      screen.getByRole("slider", { name: "Orchestration intensity" }),
      { key: "ArrowRight" }
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith(51);
    expect(screen.queryByText("Tutti orchestration")).toBeNull();
  });

  it("reseeds the draft from the effective value on every open", () => {
    const { onConfirm } = renderPopover({ intensity: 50 });
    openPopover();
    fireEvent.keyDown(
      screen.getByRole("slider", { name: "Orchestration intensity" }),
      { key: "ArrowRight" }
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    openPopover();

    expect(
      screen.getByRole("slider", { name: "Orchestration intensity" })
    ).toHaveAttribute("aria-valuenow", "50");
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("does not close on outside pointerdown", () => {
    renderPopover();
    openPopover();

    fireEvent.pointerDown(document.body);

    expect(screen.getByText("Tutti orchestration")).toBeInTheDocument();
  });

  it("escape closes only the popup and prevents the default so it cannot leak", () => {
    const { onConfirm } = renderPopover();
    openPopover();

    const defaultAllowed = fireEvent.keyDown(document.body, {
      key: "Escape"
    });

    expect(defaultAllowed).toBe(false);
    expect(screen.queryByText("Tutti orchestration")).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
