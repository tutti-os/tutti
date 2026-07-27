import type { JSX, KeyboardEvent } from "react";
import { Button } from "@tutti-os/ui-system";
import styles from "../../../agent-gui/agentGuiNode/AgentGUIConversation.styles";

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
        <Button
          className="rounded-[var(--radius-xl)] border-[var(--line-2)] dark:border-[var(--line-2)]"
          disabled={pending}
          size="sm"
          type="button"
          variant="outline"
          onClick={onCancel}
        >
          {labels.cancel}
        </Button>
        <Button
          className="rounded-[var(--radius-xl)]"
          disabled={pending || value.trim() === ""}
          size="sm"
          type="button"
          variant="default"
          onClick={() => void onSubmit()}
        >
          {labels.submit}
        </Button>
      </div>
    </div>
  );
}
