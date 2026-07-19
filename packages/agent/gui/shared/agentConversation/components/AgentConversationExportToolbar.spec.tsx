import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentConversationExportToolbar } from "./AgentConversationExportToolbar";

vi.mock("../../../i18n/index", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) =>
      key === "agentHost.agentGui.copyExportMarkdown"
        ? "Copy Markdown"
        : key === "agentHost.agentGui.exportSelectedCount"
          ? `${options?.count ?? 0} selected`
          : key
  })
}));

describe("AgentConversationExportToolbar", () => {
  it("copies the selected conversation as Markdown", () => {
    const onCopyMarkdown = vi.fn(async () => {});
    render(
      <AgentConversationExportToolbar
        exportingFormat={null}
        onClear={() => {}}
        onCopyMarkdown={onCopyMarkdown}
        onExport={async () => {}}
        selectedCount={2}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy Markdown" }));

    expect(onCopyMarkdown).toHaveBeenCalledOnce();
  });
});
