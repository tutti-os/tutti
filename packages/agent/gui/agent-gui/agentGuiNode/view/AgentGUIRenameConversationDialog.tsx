import { memo, useCallback, useEffect, useRef, useState } from "react";
import { ConfirmationDialog } from "@tutti-os/ui-system";
import { Button } from "../../../app/renderer/components/ui/button";
import type { AgentGUINodeViewModel } from "../model/agentGuiNodeTypes";
import type { AgentGUIViewLabels } from "./AgentGUINodeView.types";
import { conversationPlainTitle } from "./agentGUIViewUtils";
import type { UiLanguage } from "../../../contexts/settings/domain/uiSettings";

interface AgentGUIRenameConversationDialogProps {
  conversation: AgentGUINodeViewModel["rail"]["conversations"][number] | null;
  open: boolean;
  labels: AgentGUIViewLabels;
  uiLanguage: UiLanguage;
  onOpenChange: (open: boolean) => void;
  onRename: (agentSessionId: string, title: string) => Promise<void>;
}

export const AgentGUIRenameConversationDialog = memo(
  function AgentGUIRenameConversationDialog({
    conversation,
    open,
    labels,
    uiLanguage,
    onOpenChange,
    onRename
  }: AgentGUIRenameConversationDialogProps): React.JSX.Element {
    "use memo";
    const [title, setTitle] = useState("");
    const [isSaving, setIsSaving] = useState(false);
    const isSavingRef = useRef(false);
    const keyboardActivationRef = useRef(false);
    const inputRef = useRef<HTMLInputElement | null>(null);
    const trimmedTitle = title.trim();
    useEffect(() => {
      if (!open || !conversation) {
        isSavingRef.current = false;
        keyboardActivationRef.current = false;
        setTitle("");
        setIsSaving(false);
        return;
      }
      setTitle(conversationPlainTitle(conversation, labels, uiLanguage));
    }, [conversation, labels, open, uiLanguage]);
    useEffect(() => {
      if (!open) {
        return;
      }
      // timing: defer focus until after the dialog's open animation mounts the input
      const timer = window.setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 0);
      return () => window.clearTimeout(timer);
    }, [open, conversation?.id]);
    const closeRenameDialog = useCallback(() => {
      if (!isSavingRef.current) {
        onOpenChange(false);
      }
    }, [onOpenChange]);
    const confirmRename = useCallback(() => {
      if (!conversation || isSavingRef.current || !trimmedTitle) {
        return;
      }
      isSavingRef.current = true;
      setIsSaving(true);
      void onRename(conversation.id, trimmedTitle)
        .then(() => {
          onOpenChange(false);
        })
        .catch(() => {
          inputRef.current?.focus();
        })
        .finally(() => {
          isSavingRef.current = false;
          keyboardActivationRef.current = false;
          setIsSaving(false);
        });
    }, [conversation, onOpenChange, onRename, trimmedTitle]);
    return (
      <ConfirmationDialog
        cancelLabel={labels.cancel}
        className="sm:max-w-[480px]"
        confirmBusy={isSaving}
        confirmDisabled={!trimmedTitle}
        confirmLabel={labels.renameSessionSave}
        description={labels.renameSessionDescription}
        footer={
          <div className="flex justify-end gap-2">
            <Button
              disabled={isSaving}
              size="dialog"
              type="button"
              variant="ghost"
              onClick={closeRenameDialog}
              onPointerUp={(event) => {
                if (event.button === 0) {
                  closeRenameDialog();
                }
              }}
            >
              {labels.cancel}
            </Button>
            <Button
              className="shadow-none"
              disabled={isSaving || !trimmedTitle}
              size="dialog"
              type="button"
              variant="default"
              onClick={(event) => {
                if (event.detail !== 0) {
                  return;
                }
                if (keyboardActivationRef.current) {
                  keyboardActivationRef.current = false;
                  return;
                }
                confirmRename();
              }}
              onKeyDown={(event) => {
                if (
                  (event.key === "Enter" || event.key === " ") &&
                  !event.repeat
                ) {
                  event.preventDefault();
                  keyboardActivationRef.current = true;
                  confirmRename();
                }
              }}
              onPointerUp={(event) => {
                if (event.button === 0) {
                  confirmRename();
                }
              }}
            >
              {labels.renameSessionSave}
            </Button>
          </div>
        }
        open={open}
        title={labels.renameSessionTitle}
        onConfirm={confirmRename}
        onOpenChange={onOpenChange}
      >
        <input
          ref={inputRef}
          aria-label={labels.renameSessionTitle}
          className="h-10 w-full rounded-md border border-border bg-background px-3 text-[14px] font-medium leading-5 text-text-primary shadow-none outline-none transition-colors placeholder:text-text-tertiary focus:border-primary"
          placeholder={labels.renameSessionPlaceholder}
          value={title}
          onChange={(event) => setTitle(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              confirmRename();
            }
          }}
        />
      </ConfirmationDialog>
    );
  }
);
