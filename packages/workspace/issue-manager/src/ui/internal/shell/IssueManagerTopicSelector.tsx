import { useEffect, useState, type FormEvent, type JSX } from "react";
import {
  BareIconButton,
  Button,
  CheckIcon,
  ChevronDownIcon,
  ConfirmationDialog,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DeleteIcon,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EditIcon,
  FileCreateIcon,
  Input,
  MoreHorizontalIcon,
  PinFilledIcon,
  PinIcon,
  Textarea,
  cn
} from "@tutti-os/ui-system";
import type {
  IssueManagerCreateTopicInput,
  IssueManagerTopic,
  IssueManagerUpdateTopicInput
} from "../../../contracts/index.ts";
import type { IssueManagerI18nRuntime } from "../../../i18n/issueManagerI18n.ts";

const topicSelectorMenuItemClassName =
  "min-h-7 overflow-hidden rounded-md py-1 text-[13px] font-normal leading-[1.2] text-[var(--text-primary)]";
const topicSelectorRowItemClassName =
  "min-w-0 flex-1 bg-transparent pr-2 pl-1 hover:bg-transparent focus:bg-transparent data-[highlighted]:bg-transparent";

type IssueManagerTopicDialogMode =
  | {
      kind: "create";
      topic: null;
    }
  | {
      kind: "edit";
      topic: IssueManagerTopic;
    };

export function IssueManagerTopicSelector({
  activeTopicId,
  className,
  copy,
  onCreateTopic,
  onDeleteTopic,
  onSelectTopic,
  onUpdateTopic,
  topics
}: {
  activeTopicId: string | null;
  className?: string;
  copy: IssueManagerI18nRuntime;
  onCreateTopic: (
    input: Omit<IssueManagerCreateTopicInput, "workspaceId">
  ) => void;
  onDeleteTopic: (topicId: string) => void;
  onSelectTopic: (topicId: string) => void;
  onUpdateTopic: (
    input: Omit<IssueManagerUpdateTopicInput, "workspaceId">
  ) => void;
  topics: readonly IssueManagerTopic[];
}): JSX.Element {
  const [dialogMode, setDialogMode] =
    useState<IssueManagerTopicDialogMode | null>(null);
  const [deleteTopic, setDeleteTopic] = useState<IssueManagerTopic | null>(
    null
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const activeTopic = topics.find((topic) => topic.topicId === activeTopicId);
  const topicLabel = copy.t("labels.topic");
  const triggerLabel = formatIssueManagerTopicSelectorTriggerLabel({
    title: activeTopic?.title,
    topicLabel
  });

  const openTopicDialog = (mode: IssueManagerTopicDialogMode) => {
    setMenuOpen(false);
    setDialogMode(mode);
  };

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={topicLabel}
            className={cn(
              "max-w-[220px] gap-1 rounded-md border-0 bg-transparent text-[15px] font-normal shadow-none hover:bg-transparent focus:bg-transparent focus-visible:border-0 focus-visible:bg-transparent focus-visible:ring-0 active:bg-transparent aria-expanded:bg-transparent [&[data-state=open]>svg]:rotate-180",
              className
            )}
            size="sm"
            type="button"
            variant="ghost"
          >
            <span className="min-w-0 truncate">{triggerLabel}</span>
            <ChevronDownIcon className="size-4 shrink-0 text-[var(--text-tertiary)] transition-transform duration-200" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-[200px] px-1">
          {topics.map((topic) => {
            const isPinned = (topic.pinnedAtUnix ?? 0) > 0;
            const isActive = topic.topicId === activeTopicId;
            const pinLabel = isPinned
              ? copy.t("actions.unpinTopic")
              : copy.t("actions.pinTopic");

            return (
              <div key={topic.topicId} className="min-w-0">
                <div className="group/topic-row relative flex min-h-7 min-w-0 items-center gap-0.5 rounded-md pr-0.5 pl-0.5 hover:bg-[var(--transparency-block)] focus-within:bg-[var(--transparency-block)]">
                  <DropdownMenuItem
                    className={cn(
                      topicSelectorMenuItemClassName,
                      topicSelectorRowItemClassName
                    )}
                    onSelect={() => {
                      setMenuOpen(false);
                      onSelectTopic(topic.topicId);
                    }}
                  >
                    <span className="flex size-4 shrink-0 items-center justify-center text-[var(--accent)]">
                      {isActive ? <CheckIcon className="size-4" /> : null}
                    </span>
                    <span className="flex min-w-0 flex-1 items-center gap-2">
                      <span className="truncate">{topic.title}</span>
                      {topic.isDefault ? (
                        <span className="shrink-0 text-[11px] text-[var(--text-tertiary)]">
                          {copy.t("labels.topicDefault")}
                        </span>
                      ) : null}
                    </span>
                  </DropdownMenuItem>
                  <BareIconButton
                    aria-label={pinLabel}
                    className={cn(
                      "pointer-events-none shrink-0 opacity-0 text-[var(--text-tertiary)] transition-opacity duration-150 group-hover/topic-row:pointer-events-auto group-hover/topic-row:opacity-100 group-focus-within/topic-row:pointer-events-auto group-focus-within/topic-row:opacity-100 hover:text-[var(--text-primary)]",
                      isPinned && "text-[var(--text-primary)]"
                    )}
                    size="md"
                    title={pinLabel}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      onUpdateTopic({
                        pinned: !isPinned,
                        topicId: topic.topicId
                      });
                    }}
                  >
                    {isPinned ? (
                      <PinFilledIcon className="size-3.5" />
                    ) : (
                      <PinIcon className="size-3.5" />
                    )}
                  </BareIconButton>
                  <DropdownMenu modal={false}>
                    <DropdownMenuTrigger asChild>
                      <BareIconButton
                        aria-label={copy.t("actions.moreActions")}
                        className="pointer-events-none shrink-0 opacity-0 text-[var(--text-tertiary)] transition-opacity duration-150 group-hover/topic-row:pointer-events-auto group-hover/topic-row:opacity-100 group-focus-within/topic-row:pointer-events-auto group-focus-within/topic-row:opacity-100 hover:text-[var(--text-primary)]"
                        size="md"
                        title={copy.t("actions.moreActions")}
                        onClick={(event) => {
                          event.stopPropagation();
                        }}
                      >
                        <MoreHorizontalIcon className="size-3.5" />
                      </BareIconButton>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      align="end"
                      className="w-32"
                      sideOffset={6}
                    >
                      <DropdownMenuItem
                        onSelect={(event) => {
                          event.preventDefault();
                          openTopicDialog({
                            kind: "edit",
                            topic
                          });
                        }}
                      >
                        <EditIcon className="size-3.5" />
                        <span>{copy.t("actions.editTopic")}</span>
                      </DropdownMenuItem>
                      {!topic.isDefault ? (
                        <DropdownMenuItem
                          variant="destructive"
                          onSelect={(event) => {
                            event.preventDefault();
                            setMenuOpen(false);
                            setDeleteTopic(topic);
                          }}
                        >
                          <DeleteIcon className="size-3.5" />
                          <span>{copy.t("actions.delete")}</span>
                        </DropdownMenuItem>
                      ) : null}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            );
          })}
          {topics.length === 0 ? (
            <div className="px-3 py-2 text-[11px] leading-4 text-[var(--text-tertiary)]">
              {copy.t("messages.topicListEmpty")}
            </div>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className={cn(
              topicSelectorMenuItemClassName,
              "justify-start gap-2 px-2 text-left"
            )}
            onSelect={(event) => {
              event.preventDefault();
              openTopicDialog({
                kind: "create",
                topic: null
              });
            }}
          >
            <FileCreateIcon className="size-3.5" />
            <span className="truncate">{copy.t("actions.createTopic")}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <IssueManagerTopicDialog
        copy={copy}
        mode={dialogMode}
        open={dialogMode !== null}
        onCreateTopic={onCreateTopic}
        onOpenChange={(open) => {
          if (!open) {
            setDialogMode(null);
          }
        }}
        onUpdateTopic={onUpdateTopic}
      />
      <ConfirmationDialog
        cancelLabel={copy.t("actions.cancel")}
        confirmLabel={copy.t("actions.delete")}
        description={deleteTopic?.title}
        open={deleteTopic !== null}
        title={copy.t("confirmations.deleteTopic")}
        tone="destructive"
        onConfirm={() => {
          const topicId = deleteTopic?.topicId;
          setDeleteTopic(null);
          if (topicId) {
            onDeleteTopic(topicId);
          }
        }}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTopic(null);
          }
        }}
      />
    </>
  );
}

export function formatIssueManagerTopicSelectorTriggerLabel(input: {
  title?: string | null;
  topicLabel: string;
}): string {
  const topicLabel = input.topicLabel.trim();
  const title = input.title?.trim();
  if (!title) {
    return topicLabel;
  }
  return `${topicLabel}-${title}`;
}

function IssueManagerTopicDialog({
  copy,
  mode,
  onCreateTopic,
  onOpenChange,
  onUpdateTopic,
  open
}: {
  copy: IssueManagerI18nRuntime;
  mode: IssueManagerTopicDialogMode | null;
  onCreateTopic: (
    input: Omit<IssueManagerCreateTopicInput, "workspaceId">
  ) => void;
  onOpenChange: (open: boolean) => void;
  onUpdateTopic: (
    input: Omit<IssueManagerUpdateTopicInput, "workspaceId">
  ) => void;
  open: boolean;
}): JSX.Element {
  const [summaryDraft, setSummaryDraft] = useState("");
  const [titleDraft, setTitleDraft] = useState("");

  useEffect(() => {
    setTitleDraft(mode?.topic?.title ?? "");
    setSummaryDraft(mode?.topic?.summary ?? "");
  }, [mode]);

  const title = titleDraft.trim();
  const dialogTitle =
    mode?.kind === "edit"
      ? copy.t("labels.editTopicDialogTitle")
      : copy.t("labels.createTopicDialogTitle");

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!mode || !title) {
      return;
    }
    if (mode.kind === "edit") {
      onUpdateTopic({
        summary: summaryDraft,
        title,
        topicId: mode.topic.topicId
      });
    } else {
      onCreateTopic({
        summary: summaryDraft,
        title
      });
    }
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{dialogTitle}</DialogTitle>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={submit}>
          <label className="grid gap-2">
            <span className="text-[11px] font-medium leading-4 text-[var(--text-secondary)]">
              {copy.t("labels.topicTitle")}
            </span>
            <Input
              autoFocus
              placeholder={copy.t("labels.topicTitle")}
              value={titleDraft}
              onChange={(event) => setTitleDraft(event.target.value)}
            />
          </label>
          <label className="grid gap-2">
            <span className="text-[11px] font-medium leading-4 text-[var(--text-secondary)]">
              {copy.t("labels.topicSummary")}
            </span>
            <Textarea
              className="min-h-24 resize-none"
              placeholder={copy.t("labels.topicSummary")}
              value={summaryDraft}
              onChange={(event) => setSummaryDraft(event.target.value)}
            />
          </label>
          <DialogFooter className="pt-2">
            <Button
              size="dialog"
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              {copy.t("actions.cancel")}
            </Button>
            <Button disabled={!title} size="dialog" type="submit">
              {copy.t("actions.saveTopic")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
