import { type PointerEvent, useRef } from "react";
import {
  BareIconButton,
  Button,
  SortableItemHandle,
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from "@tutti-os/ui-system";
import {
  DeleteIcon,
  EditIcon,
  GripVerticalIcon
} from "@tutti-os/ui-system/icons";
import type { AgentHostQuickPrompt } from "../../../../host/agentHostApi";
import type { AgentQuickPromptLibraryController } from "./useAgentQuickPromptLibrary";

export function AgentQuickPromptRow({
  handleRef,
  isSorting,
  labels,
  onDelete,
  onEdit,
  onFocusNext,
  onSelect,
  pending,
  prompt,
  reorderDisabled,
  selectionRef,
  showReorderHandle
}: {
  handleRef: (node: HTMLButtonElement | null) => void;
  isSorting: boolean;
  labels: AgentQuickPromptLibraryController["labels"];
  onDelete: () => void;
  onEdit: () => void;
  onFocusNext: (offset: number) => void;
  onSelect: () => void;
  pending: boolean;
  prompt: AgentHostQuickPrompt;
  reorderDisabled: boolean;
  selectionRef: (node: HTMLButtonElement | null) => void;
  showReorderHandle: boolean;
}): React.JSX.Element {
  const selectionAction = usePrimaryPointerAction(onSelect);
  const editAction = usePrimaryPointerAction(onEdit);
  const deleteAction = usePrimaryPointerAction(onDelete);
  const actionRevealClass =
    "opacity-100 transition-opacity [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/quick-prompt-row:opacity-100 group-has-[:focus-visible]/quick-prompt-row:opacity-100 focus-visible:opacity-100";
  const promptContent = (
    <span className="flex min-w-0 flex-col items-start gap-0.5">
      <span className="w-full truncate font-medium text-[var(--text-primary)]">
        {prompt.title}
      </span>
      <span className="line-clamp-2 w-full text-[12px] leading-[1.35] text-[var(--text-secondary)]">
        {prompt.content}
      </span>
    </span>
  );

  return (
    <div className="group/quick-prompt-row flex min-w-0 items-start gap-1 rounded-md hover:bg-[var(--transparency-hover)]">
      {showReorderHandle ? (
        <div
          className={`mt-1.5 flex size-6 shrink-0 items-center justify-center ${reorderDisabled ? "cursor-not-allowed" : ""}`}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <SortableItemHandle asChild disabled={reorderDisabled}>
                <BareIconButton
                  ref={handleRef}
                  aria-label={labels.dragHandle(prompt.title)}
                  className="cursor-grab text-[var(--text-tertiary)] hover:text-[var(--text-primary)] focus-visible:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:text-[var(--text-disabled)] disabled:opacity-100"
                  size="md"
                  title=""
                >
                  <GripVerticalIcon />
                </BareIconButton>
              </SortableItemHandle>
            </TooltipTrigger>
            <TooltipContent side="top">
              {labels.dragHandle(prompt.title)}
            </TooltipContent>
          </Tooltip>
        </div>
      ) : null}
      {isSorting ? (
        <div className="h-auto min-w-0 flex-1 px-1 py-2 text-left whitespace-normal">
          {promptContent}
        </div>
      ) : (
        <Button
          {...selectionAction}
          ref={selectionRef}
          className="h-auto min-w-0 flex-1 justify-start px-1 py-2 text-left whitespace-normal hover:bg-transparent"
          disabled={pending}
          type="button"
          variant="ghost"
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              onFocusNext(event.key === "ArrowDown" ? 1 : -1);
            }
          }}
        >
          {promptContent}
        </Button>
      )}
      {!isSorting ? (
        <>
          <Tooltip>
            <TooltipTrigger asChild>
              <BareIconButton
                {...editAction}
                aria-label={labels.edit}
                className={`mt-1.5 ${actionRevealClass}`}
                disabled={pending}
                size="md"
                title=""
              >
                <EditIcon />
              </BareIconButton>
            </TooltipTrigger>
            <TooltipContent side="top">{labels.edit}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <BareIconButton
                {...deleteAction}
                aria-label={labels.delete}
                className={`mt-1.5 ${actionRevealClass}`}
                disabled={pending}
                size="md"
                title=""
              >
                <DeleteIcon />
              </BareIconButton>
            </TooltipTrigger>
            <TooltipContent side="top">{labels.delete}</TooltipContent>
          </Tooltip>
        </>
      ) : null}
    </div>
  );
}

type PrimaryPointerAction = {
  onClick: () => void;
  onPointerDown: (event: PointerEvent<HTMLButtonElement>) => void;
};

function usePrimaryPointerAction(action: () => void): PrimaryPointerAction {
  const requestedOnPointerDownRef = useRef(false);
  return {
    onPointerDown: (event) => {
      if (event.button !== 0) return;
      requestedOnPointerDownRef.current = true;
      action();
    },
    onClick: () => {
      if (requestedOnPointerDownRef.current) {
        requestedOnPointerDownRef.current = false;
        return;
      }
      action();
    }
  };
}
