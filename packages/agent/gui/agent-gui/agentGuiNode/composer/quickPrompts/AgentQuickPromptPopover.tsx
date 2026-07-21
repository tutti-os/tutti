import { type PointerEvent, useId, useRef, useState } from "react";
import {
  Button,
  ConfirmationDialog,
  DialogFooter,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ScrollArea,
  Spinner,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from "@tutti-os/ui-system";
import {
  AddIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckIcon,
  GripVerticalIcon,
  MessageSquareTextIcon,
  SearchIcon
} from "@tutti-os/ui-system/icons";
import { AgentQuickPromptEditorDialog } from "./AgentQuickPromptEditorDialog";
import { AgentQuickPromptList } from "./AgentQuickPromptList";
import type { AgentQuickPromptTemplate } from "./agentQuickPromptLabels";
import type { AgentQuickPromptLibraryController } from "./useAgentQuickPromptLibrary";

export function AgentQuickPromptPopover({
  controller,
  disabled
}: {
  controller: AgentQuickPromptLibraryController;
  disabled: boolean;
}): React.JSX.Element | null {
  const searchRef = useRef<HTMLInputElement | null>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const firstTemplateRef = useRef<HTMLButtonElement | null>(null);
  const preserveExternalFocusRef = useRef(false);
  const createRequestedOnPointerDownRef = useRef(false);
  const templateRequestedOnPointerDownRef = useRef(false);
  const [view, setView] = useState<"prompts" | "templates">("prompts");
  const [sortingState, setSortingState] = useState({
    isPopoverOpen: controller.isPopoverOpen,
    isSorting: false
  });
  let isSorting = sortingState.isSorting;
  if (sortingState.isPopoverOpen !== controller.isPopoverOpen) {
    isSorting = false;
    setSortingState({
      isPopoverOpen: controller.isPopoverOpen,
      isSorting: false
    });
  }
  const setIsSorting = (next: boolean): void => {
    setSortingState({
      isPopoverOpen: controller.isPopoverOpen,
      isSorting: next
    });
  };
  const titleId = useId();
  const { labels, snapshot } = controller;
  const templateEntryAction = usePrimaryPointerAction(() =>
    setView("templates")
  );
  const returnToPromptsAction = usePrimaryPointerAction(() =>
    setView("prompts")
  );
  const deleteCancelAction = usePrimaryPointerAction(controller.closeDialog);
  const deleteConfirmAction = usePrimaryPointerAction(() => {
    void controller.submitDelete();
  });

  if (!controller.capabilityAvailable) {
    return null;
  }

  const focusRow = (index: number): void => {
    const prompt = controller.filteredPrompts[index];
    if (prompt) rowRefs.current.get(prompt.id)?.focus();
  };
  const errorLabel =
    controller.mutationError === "conflict"
      ? labels.conflict
      : controller.mutationError === "generic"
        ? labels.mutationError
        : null;
  const requestCreate = (): void => {
    preserveExternalFocusRef.current = true;
    controller.openCreate();
  };
  const requestTemplate = (template: AgentQuickPromptTemplate): void => {
    preserveExternalFocusRef.current = true;
    if (template.action === "insert") {
      setView("prompts");
      controller.insertPromptContent(template.content);
      return;
    }
    controller.openCreate({ title: template.title, content: template.content });
  };
  const isTemplateView = view === "templates";

  return (
    <>
      <Popover
        modal={false}
        open={controller.isPopoverOpen}
        onOpenChange={(open) => {
          if (!open) {
            setView("prompts");
            setIsSorting(false);
          }
          controller.setPopoverOpen(open);
        }}
      >
        <TooltipProvider delayDuration={120}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex shrink-0">
                <PopoverTrigger asChild>
                  <Button
                    aria-label={labels.triggerTooltip}
                    disabled={disabled}
                    size="sm"
                    type="button"
                    variant="chrome"
                  >
                    <MessageSquareTextIcon data-icon="inline-start" />
                    <span className="hidden min-[900px]:inline">
                      {labels.trigger}
                    </span>
                  </Button>
                </PopoverTrigger>
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">{labels.triggerTooltip}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <PopoverContent
          aria-labelledby={titleId}
          align="start"
          className="h-[420px] max-h-[var(--radix-popover-content-available-height)] w-[400px] gap-0 overflow-hidden p-0"
          side="top"
          sideOffset={8}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            window.requestAnimationFrame(() => {
              if (isTemplateView) {
                firstTemplateRef.current?.focus();
                return;
              }
              const selectedId = controller.selectedPrompt?.id;
              const selectedRow = selectedId
                ? rowRefs.current.get(selectedId)
                : null;
              (selectedRow ?? searchRef.current)?.focus();
            });
          }}
          onCloseAutoFocus={(event) => {
            if (preserveExternalFocusRef.current) event.preventDefault();
            preserveExternalFocusRef.current = false;
          }}
        >
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--border-1)] px-3 py-2.5">
            <h2
              id={titleId}
              className="text-[14px] font-medium text-[var(--text-primary)]"
            >
              {isTemplateView ? labels.recommendedTemplatesTitle : labels.title}
            </h2>
            {isTemplateView ? (
              <Button
                size="sm"
                type="button"
                variant="ghost"
                {...returnToPromptsAction}
              >
                <ArrowLeftIcon data-icon="inline-start" />
                {labels.returnToPrompts}
              </Button>
            ) : (
              <div className="flex items-center gap-1">
                {isSorting ? (
                  <Button
                    disabled={controller.isInteractionLocked}
                    size="sm"
                    type="button"
                    variant="ghost"
                    onClick={() => setIsSorting(false)}
                  >
                    <CheckIcon data-icon="inline-start" />
                    {labels.finishSorting}
                  </Button>
                ) : (
                  <>
                    <Button
                      disabled={
                        controller.isInteractionLocked ||
                        !controller.showReorderHandles
                      }
                      size="sm"
                      type="button"
                      variant="ghost"
                      onClick={() => setIsSorting(true)}
                    >
                      <GripVerticalIcon data-icon="inline-start" />
                      {labels.startSorting}
                    </Button>
                    <Button
                      disabled={controller.isInteractionLocked}
                      size="sm"
                      type="button"
                      variant="ghost"
                      onPointerDown={(event) => {
                        if (event.button !== 0) return;
                        createRequestedOnPointerDownRef.current = true;
                        requestCreate();
                      }}
                      onClick={() => {
                        if (createRequestedOnPointerDownRef.current) {
                          createRequestedOnPointerDownRef.current = false;
                          return;
                        }
                        requestCreate();
                      }}
                    >
                      <AddIcon data-icon="inline-start" />
                      {labels.add}
                    </Button>
                  </>
                )}
              </div>
            )}
          </div>
          {!isTemplateView ? (
            <div className="relative shrink-0 px-3 py-2.5">
              <SearchIcon
                aria-hidden
                className="pointer-events-none absolute top-1/2 left-5 size-3.5 -translate-y-1/2 text-[var(--text-tertiary)]"
              />
              <Input
                ref={searchRef}
                aria-label={labels.searchPlaceholder}
                className="pl-8"
                disabled={controller.isInteractionLocked || isSorting}
                placeholder={labels.searchPlaceholder}
                value={controller.searchQuery}
                onChange={(event) =>
                  controller.setSearchQuery(event.target.value)
                }
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    focusRow(0);
                  }
                }}
              />
            </div>
          ) : null}
          {!isTemplateView &&
          snapshot.status === "error" &&
          snapshot.prompts.length > 0 ? (
            <div
              className="flex shrink-0 items-center justify-between gap-2 px-3 pb-2 text-[12px] text-[var(--state-danger)]"
              role="alert"
            >
              <span>{labels.loadError}</span>
              <Button
                size="xs"
                type="button"
                variant="ghost"
                onClick={controller.retry}
              >
                {labels.retry}
              </Button>
            </div>
          ) : null}
          {!isTemplateView && controller.reorderError ? (
            <div
              className="flex shrink-0 items-center justify-between gap-2 px-3 pb-2 text-[12px] text-[var(--state-danger)]"
              role="alert"
            >
              <span>
                {controller.reorderError === "conflict"
                  ? labels.reorderConflict
                  : labels.reorderError}
              </span>
              <Button
                size="xs"
                type="button"
                variant="ghost"
                onClick={controller.retry}
              >
                {labels.retry}
              </Button>
            </div>
          ) : null}
          <ScrollArea
            className="min-h-0 flex-1"
            viewportClassName="px-2 pb-2"
            viewportTestId="agent-quick-prompt-scroll-viewport"
          >
            {isTemplateView ? (
              <RecommendedTemplateList
                disabled={controller.isInteractionLocked}
                firstTemplateRef={firstTemplateRef}
                labels={labels}
                onSelect={requestTemplate}
                selectionRequestedOnPointerDownRef={
                  templateRequestedOnPointerDownRef
                }
              />
            ) : snapshot.status === "loading" &&
              snapshot.prompts.length === 0 ? (
              <PromptState
                icon={<Spinner size={16} />}
                label={labels.loading}
              />
            ) : snapshot.status === "error" && snapshot.prompts.length === 0 ? (
              <PromptState
                label={labels.loadError}
                action={
                  <Button
                    disabled={controller.isInteractionLocked}
                    size="sm"
                    type="button"
                    variant="ghost"
                    onClick={controller.retry}
                  >
                    {labels.retry}
                  </Button>
                }
              />
            ) : snapshot.prompts.length === 0 &&
              !controller.searchQuery.trim() ? (
              <RecommendedTemplateList
                disabled={controller.isInteractionLocked}
                firstTemplateRef={firstTemplateRef}
                labels={labels}
                onSelect={requestTemplate}
                selectionRequestedOnPointerDownRef={
                  templateRequestedOnPointerDownRef
                }
              />
            ) : controller.filteredPrompts.length === 0 ? (
              <PromptState label={labels.noResults} />
            ) : (
              <div className="flex flex-col gap-0.5">
                <AgentQuickPromptList
                  controller={controller}
                  isSorting={isSorting}
                  rowRefs={rowRefs}
                  onFocusRow={focusRow}
                  onDelete={(prompt) => {
                    preserveExternalFocusRef.current = true;
                    controller.deletePrompt(prompt);
                  }}
                  onEdit={(prompt) => {
                    preserveExternalFocusRef.current = true;
                    controller.openEdit(prompt);
                  }}
                  onSelect={(prompt) => {
                    if (isSorting) return;
                    preserveExternalFocusRef.current = true;
                    controller.selectPrompt(prompt);
                  }}
                />
                {!isSorting ? (
                  <TemplateEntry
                    label={labels.createFromTemplate}
                    action={templateEntryAction}
                    disabled={controller.isInteractionLocked}
                  />
                ) : null}
              </div>
            )}
          </ScrollArea>
        </PopoverContent>
      </Popover>
      {controller.isEditorOpen ? (
        <AgentQuickPromptEditorDialog controller={controller} />
      ) : null}
      <ConfirmationDialog
        cancelLabel={labels.cancel}
        confirmBusy={controller.isDeleting}
        confirmLabel={
          controller.isDeleting ? labels.deleting : labels.deleteConfirm
        }
        description={
          controller.promptToDelete
            ? labels.deleteDescription(controller.promptToDelete.title)
            : undefined
        }
        footer={
          <DialogFooter>
            <Button
              {...deleteCancelAction}
              disabled={controller.isDeleting}
              size="dialog"
              type="button"
              variant="ghost"
            >
              {labels.cancel}
            </Button>
            <Button
              {...deleteConfirmAction}
              disabled={controller.isDeleting}
              size="dialog"
              type="button"
              variant="destructive"
            >
              {controller.isDeleting ? labels.deleting : labels.deleteConfirm}
            </Button>
          </DialogFooter>
        }
        onOpenChange={(open) => {
          if (!open && !controller.isDeleting) controller.closeDialog();
        }}
        open={controller.mode === "delete"}
        title={labels.deleteTitle}
        tone="destructive"
      >
        {errorLabel ? (
          <p className="text-[12px] text-[var(--state-danger)]" role="alert">
            {errorLabel}
          </p>
        ) : null}
      </ConfirmationDialog>
    </>
  );
}

function RecommendedTemplateList({
  disabled,
  firstTemplateRef,
  labels,
  onSelect,
  selectionRequestedOnPointerDownRef
}: {
  disabled: boolean;
  firstTemplateRef: React.RefObject<HTMLButtonElement | null>;
  labels: AgentQuickPromptLibraryController["labels"];
  onSelect: (template: AgentQuickPromptTemplate) => void;
  selectionRequestedOnPointerDownRef: React.MutableRefObject<boolean>;
}): React.JSX.Element {
  return (
    <section className="flex flex-col gap-1 px-1 pt-2">
      <div className="px-2 pb-1">
        <h3 className="text-[13px] font-medium text-[var(--text-primary)]">
          {labels.recommendedTemplatesTitle}
        </h3>
        <p className="pt-0.5 text-[12px] leading-[1.35] text-[var(--text-secondary)]">
          {labels.recommendedTemplatesDescription}
        </p>
      </div>
      {labels.recommendedTemplates.map((template, index) => (
        <Button
          key={template.id}
          ref={index === 0 ? firstTemplateRef : undefined}
          className="h-auto w-full justify-between px-2 py-2 text-left whitespace-normal"
          disabled={disabled}
          type="button"
          variant="ghost"
          onPointerDown={(event) => {
            if (disabled || event.button !== 0) return;
            selectionRequestedOnPointerDownRef.current = true;
            onSelect(template);
          }}
          onClick={() => {
            if (disabled) return;
            if (selectionRequestedOnPointerDownRef.current) {
              selectionRequestedOnPointerDownRef.current = false;
              return;
            }
            onSelect(template);
          }}
        >
          <span className="flex min-w-0 flex-col items-start gap-0.5">
            <span className="w-full truncate font-medium text-[var(--text-primary)]">
              {template.title}
            </span>
            <span className="line-clamp-2 w-full text-[12px] leading-[1.35] text-[var(--text-secondary)]">
              {template.description}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-1 text-[12px] text-[var(--text-secondary)]">
            {template.action === "insert"
              ? labels.usePrompt
              : labels.useTemplate}
            <ArrowRightIcon data-icon="inline-end" />
          </span>
        </Button>
      ))}
    </section>
  );
}

function TemplateEntry({
  action,
  disabled,
  label
}: {
  action: PrimaryPointerAction;
  disabled: boolean;
  label: string;
}): React.JSX.Element {
  return (
    <Button
      {...action}
      className="mt-1 h-auto w-full justify-between px-2 py-2 text-left whitespace-normal"
      disabled={disabled}
      type="button"
      variant="ghost"
    >
      <span className="font-medium">{label}</span>
      <ArrowRightIcon data-icon="inline-end" />
    </Button>
  );
}

type PrimaryPointerAction = {
  onClick: () => void;
  onPointerDown: (event: PointerEvent<HTMLButtonElement>) => void;
};

function usePrimaryPointerAction(action: () => void): PrimaryPointerAction {
  const actionRequestedOnPointerDownRef = useRef(false);

  return {
    onPointerDown: (event) => {
      if (event.button !== 0) return;
      actionRequestedOnPointerDownRef.current = true;
      event.preventDefault();
      action();
    },
    onClick: () => {
      if (actionRequestedOnPointerDownRef.current) {
        actionRequestedOnPointerDownRef.current = false;
        return;
      }
      action();
    }
  };
}

function PromptState({
  action,
  icon,
  label
}: {
  action?: React.ReactNode;
  icon?: React.ReactNode;
  label: string;
}): React.JSX.Element {
  return (
    <div className="flex min-h-[180px] flex-col items-center justify-center gap-2 px-4 text-center text-[13px] text-[var(--text-secondary)]">
      {icon}
      <span>{label}</span>
      {action}
    </div>
  );
}
