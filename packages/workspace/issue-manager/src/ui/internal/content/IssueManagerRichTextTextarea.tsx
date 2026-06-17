import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { RichTextAtEditor } from "@tutti-os/ui-rich-text/editor";
import { Button, LinkIcon, cn } from "@tutti-os/ui-system";
import type {
  IssueManagerController,
  IssueManagerRichTextSurface
} from "../../react/index.ts";
import {
  IssueManagerMentionPanel,
  useIssueManagerMentionPanelController
} from "./IssueManagerMentionPanel.tsx";

const issueManagerRichTextTextareaBaseClassName =
  "min-h-20 w-full rounded-[8px] border border-transparent bg-[var(--transparency-block)] p-3 text-[13px] font-normal leading-[1.3] text-[var(--text-primary)] transition-[background-color,border-color,color] outline-none shadow-none placeholder:text-[var(--text-placeholder)] hover:bg-[var(--transparency-hover)] focus:bg-[var(--transparency-hover)] focus-visible:border-transparent focus-visible:bg-[var(--transparency-hover)] focus-visible:ring-0 disabled:cursor-not-allowed disabled:bg-[var(--transparency-block)] disabled:text-[var(--text-disabled)] disabled:opacity-100 aria-invalid:border-[var(--state-danger)] aria-invalid:bg-[var(--transparency-block)] aria-invalid:hover:bg-[var(--transparency-hover)] aria-invalid:focus:bg-[var(--transparency-hover)] aria-invalid:focus-visible:bg-[var(--transparency-hover)] aria-invalid:ring-0 aria-invalid:shadow-none";

const issueManagerRichTextPlaceholderBaseClassName =
  "min-h-20 w-full p-3 text-[13px] font-normal leading-[1.3] text-[var(--text-placeholder)]";

export function IssueManagerRichTextTextarea({
  controller,
  onChange,
  placeholder,
  surface,
  textareaClassName,
  value
}: {
  controller: IssueManagerController;
  onChange: (value: string) => void;
  placeholder?: string;
  surface: IssueManagerRichTextSurface;
  textareaClassName?: string;
  value: string;
}): JSX.Element {
  const providers = useMemo(
    () => controller.resolveRichTextAtProviders(surface),
    [controller, surface]
  );
  const mentionPanel = useIssueManagerMentionPanelController(controller);
  const showReferenceAction = controller.canReferenceWorkspaceFiles;
  const [focusSignal, setFocusSignal] = useState(0);
  const previousValueRef = useRef(value);
  const wasAddingReferenceRef = useRef(false);

  useEffect(() => {
    const isAddingReference =
      controller.referenceTarget?.mode === "insert" &&
      controller.referenceTarget.parentKind === surface;
    if (
      wasAddingReferenceRef.current &&
      !isAddingReference &&
      value !== previousValueRef.current
    ) {
      setFocusSignal((current) => current + 1);
    }
    wasAddingReferenceRef.current = isAddingReference;
    previousValueRef.current = value;
  }, [controller.referenceTarget, surface, value]);

  return (
    <RichTextAtEditor
      focusSignal={focusSignal}
      maxResults={8}
      minQueryLength={0}
      onCycleFilter={mentionPanel.cycleFilter}
      providers={providers}
      textOverrides={{
        loadingLabel: controller.copy.t("richTextAt.loading"),
        noMatchesLabel: controller.copy.t("richTextAt.noMatches"),
        removeReferenceActionLabel: controller.copy.t("actions.removeReference")
      }}
      textareaClassName={cn(
        issueManagerRichTextTextareaBaseClassName,
        textareaClassName,
        showReferenceAction && "pb-11"
      )}
      placeholderClassName={cn(
        issueManagerRichTextPlaceholderBaseClassName,
        textareaClassName,
        showReferenceAction && "pb-11"
      )}
      placeholder={placeholder}
      renderPanel={(context) => (
        <IssueManagerMentionPanel
          activeFilterId={mentionPanel.activeFilterId}
          context={context}
          controller={controller}
          expandedCounts={mentionPanel.expandedCounts}
          panelConfig={mentionPanel.config}
          onCycleFilter={mentionPanel.cycleFilter}
          onExpandGroup={mentionPanel.expandGroup}
          onSelectFilter={mentionPanel.setActiveFilterId}
        />
      )}
      value={value}
      onChange={onChange}
      overlay={
        showReferenceAction ? (
          <div className="pointer-events-none absolute inset-x-3 bottom-3 z-10 flex">
            <Button
              className="pointer-events-auto"
              size="default"
              type="button"
              variant="secondary"
              onClick={() => {
                void controller.insertReferences(surface);
              }}
            >
              <LinkIcon size={14} />
              {controller.copy.t("actions.referenceWorkspaceFiles")}
            </Button>
          </div>
        ) : null
      }
    />
  );
}
