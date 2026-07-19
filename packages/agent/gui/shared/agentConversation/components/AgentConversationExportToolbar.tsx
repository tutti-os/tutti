import { Button } from "@tutti-os/ui-system";
import { CopyIcon, DownloadIcon } from "@tutti-os/ui-system/icons";
import type { JSX } from "react";
import { useTranslation } from "../../../i18n/index";

export function AgentConversationExportToolbar({
  exportingFormat,
  onClear,
  onCopyMarkdown,
  onExport,
  selectedCount
}: {
  exportingFormat: "copy-markdown" | "markdown" | "pdf" | null;
  onClear: () => void;
  onCopyMarkdown: () => Promise<void>;
  onExport: (format: "markdown" | "pdf") => Promise<void>;
  selectedCount: number;
}): JSX.Element | null {
  const { t } = useTranslation();
  if (selectedCount === 0) return null;

  return (
    <div
      className="sticky bottom-4 z-30 mx-auto flex w-fit max-w-[calc(100%-24px)] items-center gap-2 rounded-[10px] border border-[var(--line-2)] bg-[var(--background-panel)] px-3 py-2 shadow-[0_10px_30px_color-mix(in_srgb,var(--text-primary)_16%,transparent)]"
      data-testid="agent-conversation-export-toolbar"
    >
      <span className="whitespace-nowrap text-[12px] text-[var(--text-secondary)]">
        {t("agentHost.agentGui.exportSelectedCount", {
          count: selectedCount
        })}
      </span>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        disabled={exportingFormat !== null}
        onClick={() => void onCopyMarkdown()}
      >
        <CopyIcon aria-hidden="true" />
        {exportingFormat === "copy-markdown"
          ? t("agentHost.agentGui.copyingExportMarkdown")
          : t("agentHost.agentGui.copyExportMarkdown")}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        disabled={exportingFormat !== null}
        onClick={() => void onExport("markdown")}
      >
        <DownloadIcon aria-hidden="true" />
        {t("agentHost.agentGui.exportMarkdown")}
      </Button>
      <Button
        type="button"
        size="sm"
        disabled={exportingFormat !== null}
        onClick={() => void onExport("pdf")}
      >
        <DownloadIcon aria-hidden="true" />
        {exportingFormat === "pdf"
          ? t("agentHost.agentGui.exportingConversation")
          : t("agentHost.agentGui.exportPdf")}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={exportingFormat !== null}
        onClick={onClear}
      >
        {t("agentHost.agentGui.clearExportSelection")}
      </Button>
    </div>
  );
}
