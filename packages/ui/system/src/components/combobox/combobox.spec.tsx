import type * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Combobox } from "./combobox";

vi.stubGlobal(
  "ResizeObserver",
  class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

const options = [
  { label: "gpt-5.5", value: "gpt-5.5" },
  {
    description: "Claude Sonnet",
    keywords: ["Sonnet"],
    label: "claude-sonnet-4-6",
    value: "claude-sonnet-4-6"
  },
  { label: "deepseek-chat", value: "deepseek-chat" }
];

function renderCombobox(
  props: Partial<React.ComponentProps<typeof Combobox>> = {}
) {
  const onValueChange = vi.fn();
  render(
    <Combobox
      aria-label="Model"
      options={options}
      searchPlaceholder="Search models"
      value=""
      onValueChange={onValueChange}
      {...props}
    />
  );
  return { onValueChange };
}

function openCombobox() {
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  return screen.getByPlaceholderText("Search models");
}

function activeRowText(): string | null {
  const active = screen
    .getAllByRole("option")
    .find((row) => row.dataset.active === "true");
  return active?.textContent ?? null;
}

describe("Combobox", () => {
  it("shows the placeholder until a value is selected", () => {
    renderCombobox({ placeholder: "Pick a model" });

    expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent(
      "Pick a model"
    );
  });

  it("keeps the combobox role on the search input only", () => {
    renderCombobox();

    // Closed: the trigger is a plain popover button, not a second combobox.
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();

    const search = openCombobox();
    const comboboxes = screen.getAllByRole("combobox");
    expect(comboboxes).toHaveLength(1);
    expect(comboboxes[0]).toBe(search);
    expect(search).toHaveAttribute("aria-expanded", "true");
  });

  it("commits a clicked option and closes the surface", () => {
    const { onValueChange } = renderCombobox();
    openCombobox();

    fireEvent.click(screen.getByRole("option", { name: "gpt-5.5" }));

    expect(onValueChange).toHaveBeenCalledWith("gpt-5.5");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("wraps arrow-key navigation around both ends and commits with Enter", () => {
    const { onValueChange } = renderCombobox();
    const search = openCombobox();

    expect(activeRowText()).toContain("gpt-5.5");

    fireEvent.keyDown(search, { key: "ArrowUp" });
    expect(activeRowText()).toContain("deepseek-chat");

    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(activeRowText()).toContain("gpt-5.5");

    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(activeRowText()).toContain("deepseek-chat");

    fireEvent.keyDown(search, { key: "Enter" });
    expect(onValueChange).toHaveBeenCalledWith("deepseek-chat");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("jumps to the first and last rows with Home and End", () => {
    renderCombobox();
    const search = openCombobox();

    fireEvent.keyDown(search, { key: "End" });
    expect(activeRowText()).toContain("deepseek-chat");

    fireEvent.keyDown(search, { key: "Home" });
    expect(activeRowText()).toContain("gpt-5.5");
  });

  it("filters rows by option keywords", () => {
    renderCombobox();
    const search = openCombobox();

    fireEvent.change(search, { target: { value: "sonnet" } });

    const rows = screen.getAllByRole("option");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("claude-sonnet-4-6");
  });

  it("offers the typed query as a custom value and commits it", () => {
    const { onValueChange } = renderCombobox({
      allowCustomValue: true,
      customValueLabel: (query) => `Use "${query}"`,
      emptyMessage: "No matches"
    });
    const search = openCombobox();

    fireEvent.change(search, { target: { value: "my-private-model" } });

    const rows = screen.getAllByRole("option");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('Use "my-private-model"');

    fireEvent.keyDown(search, { key: "Enter" });
    expect(onValueChange).toHaveBeenCalledWith("my-private-model");
  });

  it("excludes a custom row when the query matches an existing option id", () => {
    renderCombobox({ allowCustomValue: true });
    const search = openCombobox();

    fireEvent.change(search, { target: { value: "gpt-5.5" } });

    const rows = screen.getAllByRole("option");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("gpt-5.5");
  });

  it("never commits a disabled row", () => {
    const { onValueChange } = renderCombobox({
      options: [{ disabled: true, label: "gpt-5.5", value: "gpt-5.5" }]
    });
    const search = openCombobox();

    fireEvent.keyDown(search, { key: "Enter" });
    fireEvent.click(screen.getByRole("option", { name: "gpt-5.5" }));

    expect(onValueChange).not.toHaveBeenCalled();
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("shows the empty message when nothing matches and custom values are off", () => {
    renderCombobox({ emptyMessage: "No matching models." });
    const search = openCombobox();

    fireEvent.change(search, { target: { value: "unknown-model" } });

    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("No matching models.")).toBeInTheDocument();
  });
});
