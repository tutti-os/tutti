import type { JSX, KeyboardEvent } from "react";
import { CheckIcon, CloseIcon } from "@tutti-os/ui-system/icons";
import styles from "../../../agent-gui/agentGuiNode/AgentGUIConversation.styles";
import { CanvasNodeGhostIconButton } from "../../../contexts/workspace/presentation/renderer/components/shared/CanvasNodeGhostIconButton";

export interface AgentUserMessageEditRetryControl {
  pending: boolean;
  labels: {
    edit: string;
    cancel: string;
    submit: string;
  };
  onSubmit: (input: {
    editedText: string;
    turnId: string;
  }) => boolean | Promise<boolean>;
}

export function AgentUserMessageEditor({
  value,
  pending,
  labels,
  onChange,
  onCancel,
  onSubmit,
  onKeyDown
}: {
  value: string;
  pending: boolean;
  labels: AgentUserMessageEditRetryControl["labels"];
  onChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => Promise<void>;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
}): JSX.Element {
  "use memo";
  return (
    <div
      className={`workspace-agents-status-panel__detail-user-message ${styles.userMessageBubble} ${styles.userMessageEditor}`}
      aria-busy={pending ? "true" : undefined}
    >
      <textarea
        autoFocus
        className={styles.userMessageEditorTextarea}
        value={value}
        disabled={pending}
        aria-label={labels.edit}
        onChange={(event) => onChange(event.currentTarget.value)}
        onKeyDown={onKeyDown}
      />
      <div className={styles.userMessageEditorActions}>
        <CanvasNodeGhostIconButton
          aria-label={labels.cancel}
          disabled={pending}
          onClick={onCancel}
        >
          <CloseIcon width={14} height={14} aria-hidden="true" />
        </CanvasNodeGhostIconButton>
        <CanvasNodeGhostIconButton
          aria-label={labels.submit}
          disabled={pending || value.trim() === ""}
          onClick={() => void onSubmit()}
        >
          <CheckIcon width={14} height={14} aria-hidden="true" />
        </CanvasNodeGhostIconButton>
      </div>
    </div>
  );
}
