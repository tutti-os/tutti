import type { JSX } from "react";
import { Checkbox } from "@tutti-os/ui-system";
import { translate } from "../../../i18n/index";
import { formatAgentMessageTimestamp } from "../../../app/renderer/shell/utils/format";
import type { AgentGeneratedImageRowVM } from "../contracts/agentGeneratedImageRowVM";
import { AgentGeneratedImagePreview } from "./AgentGeneratedImagePreview";
import styles from "../../../agent-gui/agentGuiNode/AgentGUIConversation.styles";

export function AgentGeneratedImageRow({
  row,
  exportSelection
}: {
  row: AgentGeneratedImageRowVM;
  exportSelection?: {
    checked: boolean;
    label: string;
    onToggle: () => void;
    selectionMode: boolean;
  };
}): JSX.Element {
  "use memo";
  const image = (
    <div
      className="flex max-w-full justify-start"
      data-testid="agent-generated-image-artifact"
    >
      <AgentGeneratedImagePreview
        uri={row.uri}
        mimeType={row.mimeType}
        alt={translate("agentHost.agentTool.details.imagePreviewAlt")}
        className="block max-h-[560px] max-w-full rounded-[10px] border border-[var(--line-2)] bg-[var(--background-panel)] object-contain"
      />
    </div>
  );
  if (!exportSelection) return image;
  const timestamp = formatAgentMessageTimestamp(row.occurredAtUnixMs);
  return (
    <div className={styles.messageGroup} data-agent-message-speaker="assistant">
      {image}
      <div
        className={styles.messageFooter}
        data-export-selected={exportSelection.checked ? "true" : undefined}
        data-export-selection-mode={
          exportSelection.selectionMode ? "true" : undefined
        }
      >
        <Checkbox
          aria-label={exportSelection.label}
          checked={exportSelection.checked}
          className={styles.messageExportCheckbox}
          onCheckedChange={() => exportSelection.onToggle()}
        />
        {timestamp ? (
          <span className={styles.messageTimestamp}>{timestamp}</span>
        ) : null}
      </div>
    </div>
  );
}
