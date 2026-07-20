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
  labels,
  onDelete,
  onEdit,
  onFocusNext,
  onSelect,
  pending,
  prompt,
  selectionRef,
  showReorderHandle
}: {
  handleRef: (node: HTMLButtonElement | null) => void;
  labels: AgentQuickPromptLibraryController["labels"];
  onDelete: () => void;
  onEdit: () => void;
  onFocusNext: (offset: number) => void;
  onSelect: () => void;
  pending: boolean;
  prompt: AgentHostQuickPrompt;
  selectionRef: (node: HTMLButtonElement | null) => void;
  showReorderHandle: boolean;
}): React.JSX.Element {
  const selectionAction = usePrimaryPointerAction(onSelect);
  const editAction = usePrimaryPointerAction(onEdit);
  const deleteAction = usePrimaryPointerAction(onDelete);
  const revealClass =
    "opacity-100 transition-opacity [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/quick-prompt-row:opacity-100 group-has-[:focus-visible]/quick-prompt-row:opacity-100 focus-visible:opacity-100";

  return (
    <div className="group/quick-prompt-row flex min-w-0 items-start gap-1 rounded-md hover:bg-[var(--transparency-hover)]">
      {showReorderHandle ? (
        <div className="mt-1.5 flex size-6 shrink-0 items-center justify-center">
          <Tooltip>
            <TooltipTrigger asChild>
              <SortableItemHandle asChild disabled={pending}>
                <BareIconButton
                  ref={handleRef}
                  aria-label={labels.dragHandle(prompt.title)}
                  className={revealClass}
                  size="md"
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
        <span className="flex min-w-0 flex-col items-start gap-0.5">
          <span className="w-full truncate font-medium text-[var(--text-primary)]">
            {prompt.title}
          </span>
          <span className="line-clamp-2 w-full text-[12px] leading-[1.35] text-[var(--text-secondary)]">
            {prompt.content}
          </span>
        </span>
      </Button>
      <Tooltip>
        <TooltipTrigger asChild>
          <BareIconButton
            {...editAction}
            aria-label={labels.edit}
            className={`mt-1.5 ${revealClass}`}
            disabled={pending}
            size="md"
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
            className={`mt-1.5 ${revealClass}`}
            disabled={pending}
            size="md"
          >
            <DeleteIcon />
          </BareIconButton>
        </TooltipTrigger>
        <TooltipContent side="top">{labels.delete}</TooltipContent>
      </Tooltip>
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
