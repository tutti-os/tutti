import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Button,
  DeleteIcon,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  FolderIcon,
  Input,
  LoadingIcon,
  RestoreIcon,
  SearchIcon,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from "@tutti-os/ui-system";
import type { DeletedAgentConversationRetentionDays } from "@shared/preferences";
import { deletedAgentConversationRetentionDaysOptions } from "@shared/preferences";
import type { DesktopLocale } from "@shared/i18n";
import { useTranslation } from "@renderer/i18n";
import type { IWorkspaceDeletedConversationsController } from "../services/workspaceSettingsService.interface.ts";
import type {
  WorkspaceDeletedConversation,
  WorkspaceDeletedConversationProjectFilter,
  WorkspaceDeletedConversationsSnapshotState
} from "../services/workspaceSettingsTypes.ts";
import {
  workspaceSettingsInputClass,
  workspaceSettingsSelectContentClass,
  workspaceSettingsSelectTriggerClass
} from "./workspaceSettingsFieldStyles.ts";

export function WorkspaceDeletedConversationsSection({
  changingRetentionDays,
  controller,
  retentionDays,
  state,
  onRetentionDaysChange
}: {
  changingRetentionDays: DeletedAgentConversationRetentionDays | null;
  controller: IWorkspaceDeletedConversationsController;
  retentionDays: DeletedAgentConversationRetentionDays;
  state: WorkspaceDeletedConversationsSnapshotState;
  onRetentionDaysChange: (days: DeletedAgentConversationRetentionDays) => void;
}) {
  const { locale, t } = useTranslation();
  const pendingRetentionDays = changingRetentionDays ?? retentionDays;
  const [deleteAllDialogOpen, setDeleteAllDialogOpen] = useState(false);
  const [deleteAllConfirmation, setDeleteAllConfirmation] = useState("");
  const [pendingDelete, setPendingDelete] =
    useState<WorkspaceDeletedConversation | null>(null);
  const confirmationPhrase = t(
    "workspace.settings.deletedConversations.deleteAllConfirmationPhrase"
  );
  const projectFilterValue = serializeProjectFilter(state.projectFilter);
  const filtersActive =
    state.search.trim() !== "" || state.projectFilter.kind !== "all";

  return (
    <section
      aria-labelledby="workspace-deleted-conversations-title"
      className="flex h-full min-h-0 flex-col"
    >
      <header className="shrink-0 border-b border-[var(--border-1)] px-[22px] pb-4 pt-5">
        <div className="flex items-center justify-between gap-4 max-[680px]:flex-col max-[680px]:items-stretch">
          <div className="min-w-0 flex-1">
            <h3
              id="workspace-deleted-conversations-title"
              className="m-0 text-[20px] font-semibold leading-[1.3] text-[var(--text-primary)]"
            >
              {t("workspace.settings.deletedConversations.title")}
            </h3>
          </div>
          <div className="flex shrink-0 items-center gap-2 max-[680px]:w-full max-[680px]:flex-wrap">
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className="text-[12px] text-[var(--text-secondary)]"
                  tabIndex={0}
                >
                  {t("workspace.settings.deletedConversations.retentionLabel")}
                </span>
              </TooltipTrigger>
              <TooltipContent side="top">
                {t(
                  "workspace.settings.deletedConversations.retentionDescription"
                )}
              </TooltipContent>
            </Tooltip>
            <Select
              disabled={changingRetentionDays !== null || state.purgingAll}
              value={String(pendingRetentionDays)}
              onValueChange={(value) =>
                onRetentionDaysChange(
                  Number(value) as DeletedAgentConversationRetentionDays
                )
              }
            >
              <SelectTrigger
                aria-label={t(
                  "workspace.settings.deletedConversations.retentionLabel"
                )}
                className="h-8 w-[92px] min-w-[92px]"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent
                className={workspaceSettingsSelectContentClass}
                style={{ zIndex: "var(--z-panel-popover)" }}
              >
                {deletedAgentConversationRetentionDaysOptions.map((days) => (
                  <SelectItem key={days} value={String(days)}>
                    {t(
                      "workspace.settings.deletedConversations.retentionDays",
                      { count: String(days) }
                    )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              disabled={state.purgingAll || state.workspaceTotalCount === 0}
              variant="destructive-secondary"
              onClick={() => {
                setDeleteAllConfirmation("");
                setDeleteAllDialogOpen(true);
              }}
            >
              {state.purgingAll ? (
                <LoadingIcon data-icon="inline-start" />
              ) : (
                <DeleteIcon data-icon="inline-start" />
              )}
              {t(
                state.purgingAll
                  ? "workspace.settings.deletedConversations.deletingAll"
                  : "workspace.settings.deletedConversations.deleteAll"
              )}
            </Button>
          </div>
        </div>

        <div className="mt-4 flex items-center gap-2 max-[560px]:flex-col">
          <div className="relative min-w-0 flex-1 max-[560px]:w-full">
            <SearchIcon
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 z-[1] size-4 -translate-y-1/2 text-[var(--text-tertiary)]"
            />
            <Input
              aria-label={t(
                "workspace.settings.deletedConversations.searchLabel"
              )}
              className={`${workspaceSettingsInputClass} pl-9`}
              disabled={state.purgingAll}
              placeholder={t(
                "workspace.settings.deletedConversations.searchPlaceholder"
              )}
              type="search"
              value={state.search}
              onChange={(event) => controller.setSearch(event.target.value)}
            />
          </div>
          <Select
            disabled={state.purgingAll}
            value={projectFilterValue}
            onValueChange={(value) =>
              controller.selectProject(deserializeProjectFilter(value))
            }
          >
            <SelectTrigger
              aria-label={t(
                "workspace.settings.deletedConversations.projectFilterLabel"
              )}
              className={`${workspaceSettingsSelectTriggerClass} w-[220px] max-[560px]:w-full`}
            >
              <FolderIcon aria-hidden="true" className="size-4 shrink-0" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent
              className={workspaceSettingsSelectContentClass}
              style={{ zIndex: "var(--z-panel-popover)" }}
            >
              <SelectItem value="all">
                {t("workspace.settings.deletedConversations.allProjects")}
              </SelectItem>
              <SelectItem value="unscoped">
                {t("workspace.settings.deletedConversations.unscoped")}
              </SelectItem>
              {state.projectOptions.map((project) => (
                <SelectItem
                  key={project.railSectionKey}
                  value={`project:${project.railSectionKey}`}
                >
                  {project.projectAvailable
                    ? project.projectLabel
                    : t(
                        "workspace.settings.deletedConversations.removedProject",
                        { project: project.projectLabel }
                      )}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </header>

      <DeletedConversationsBody
        controller={controller}
        filtersActive={filtersActive}
        locale={locale}
        state={state}
        onRequestDelete={setPendingDelete}
      />

      <PermanentDeleteDialog
        conversation={pendingDelete}
        deleting={
          pendingDelete
            ? state.operationBySessionID[pendingDelete.agentSessionId] ===
              "deleting"
            : false
        }
        onOpenChange={(open) => {
          if (!open) {
            setPendingDelete(null);
          }
        }}
        onConfirm={async () => {
          if (!pendingDelete) {
            return;
          }
          await controller.purgeOne(pendingDelete.agentSessionId);
          setPendingDelete(null);
        }}
      />

      <Dialog open={deleteAllDialogOpen} onOpenChange={setDeleteAllDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("workspace.settings.deletedConversations.deleteAllTitle")}
            </DialogTitle>
            <DialogDescription>
              {t(
                "workspace.settings.deletedConversations.deleteAllDescription",
                {
                  count: String(state.workspaceTotalCount),
                  phrase: confirmationPhrase
                }
              )}
            </DialogDescription>
          </DialogHeader>
          <Input
            aria-label={t(
              "workspace.settings.deletedConversations.deleteAllConfirmationLabel"
            )}
            autoComplete="off"
            value={deleteAllConfirmation}
            onChange={(event) => setDeleteAllConfirmation(event.target.value)}
          />
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setDeleteAllDialogOpen(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              disabled={
                deleteAllConfirmation !== confirmationPhrase || state.purgingAll
              }
              variant="destructive"
              onClick={() => {
                void controller.purgeAll().finally(() => {
                  setDeleteAllDialogOpen(false);
                  setDeleteAllConfirmation("");
                });
              }}
            >
              {t("workspace.settings.deletedConversations.deleteAllConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function DeletedConversationsBody({
  controller,
  filtersActive,
  locale,
  state,
  onRequestDelete
}: {
  controller: IWorkspaceDeletedConversationsController;
  filtersActive: boolean;
  locale: DesktopLocale;
  state: WorkspaceDeletedConversationsSnapshotState;
  onRequestDelete: (conversation: WorkspaceDeletedConversation) => void;
}) {
  const { t } = useTranslation();
  if (state.loading && state.sessions.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-[var(--text-secondary)]">
        <LoadingIcon className="size-5" />
        <span className="sr-only">{t("common.loading")}</span>
      </div>
    );
  }
  if (state.loadFailed && state.sessions.length === 0) {
    return (
      <DeletedConversationsEmptyState
        actionLabel={t("common.retry")}
        description={t(
          "workspace.settings.deletedConversations.loadFailedDescription"
        )}
        title={t("workspace.settings.deletedConversations.loadFailedTitle")}
        onAction={() => void controller.refresh()}
      />
    );
  }
  if (state.sessions.length === 0) {
    return filtersActive ? (
      <DeletedConversationsEmptyState
        actionLabel={t("workspace.settings.deletedConversations.clearFilters")}
        description={t(
          "workspace.settings.deletedConversations.noResultsDescription"
        )}
        title={t("workspace.settings.deletedConversations.noResultsTitle")}
        onAction={() => controller.clearFilters()}
      />
    ) : (
      <DeletedConversationsEmptyState
        description={t(
          "workspace.settings.deletedConversations.emptyDescription"
        )}
        title={t("workspace.settings.deletedConversations.emptyTitle")}
      />
    );
  }
  return (
    <DeletedConversationVirtualList
      controller={controller}
      locale={locale}
      state={state}
      onRequestDelete={onRequestDelete}
    />
  );
}

function DeletedConversationVirtualList({
  controller,
  locale,
  state,
  onRequestDelete
}: {
  controller: IWorkspaceDeletedConversationsController;
  locale: DesktopLocale;
  state: WorkspaceDeletedConversationsSnapshotState;
  onRequestDelete: (conversation: WorkspaceDeletedConversation) => void;
}) {
  const { t } = useTranslation();
  const scrollElementRef = useRef<HTMLDivElement>(null);
  const count = state.sessions.length + (state.hasMore ? 1 : 0);
  const rowVirtualizer = useVirtualizer({
    count,
    estimateSize: () => 68,
    getItemKey: (index) =>
      state.sessions[index]?.agentSessionId ?? "deleted-conversations-loader",
    getScrollElement: () => scrollElementRef.current,
    overscan: 6
  });
  const virtualItems = rowVirtualizer.getVirtualItems();
  const lastVirtualIndex = virtualItems.at(-1)?.index ?? -1;

  useEffect(() => {
    if (
      state.hasMore &&
      !state.loadMoreFailed &&
      lastVirtualIndex >= state.sessions.length - 5
    ) {
      void controller.loadMore();
    }
  }, [
    controller,
    lastVirtualIndex,
    state.hasMore,
    state.loadMoreFailed,
    state.sessions.length
  ]);

  return (
    <div
      ref={scrollElementRef}
      aria-label={t("workspace.settings.deletedConversations.listLabel")}
      className="min-h-0 flex-1 overflow-y-auto px-[22px] py-3"
      role="list"
    >
      <div
        className="relative w-full"
        style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
      >
        {virtualItems.map((virtualItem) => {
          const conversation = state.sessions[virtualItem.index];
          return (
            <div
              key={virtualItem.key}
              className="absolute left-0 top-0 w-full pb-2"
              role={conversation ? "listitem" : undefined}
              style={{
                height: `${virtualItem.size}px`,
                transform: `translateY(${virtualItem.start}px)`
              }}
            >
              {conversation ? (
                <DeletedConversationRow
                  conversation={conversation}
                  locale={locale}
                  operation={
                    state.operationBySessionID[conversation.agentSessionId]
                  }
                  onDelete={() => onRequestDelete(conversation)}
                  onRestore={() =>
                    void controller.restore(conversation.agentSessionId)
                  }
                />
              ) : (
                <div className="flex h-[60px] items-center justify-center text-[12px] text-[var(--text-secondary)]">
                  {state.loadMoreFailed ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void controller.loadMore()}
                    >
                      {t("common.retry")}
                    </Button>
                  ) : (
                    <>
                      <LoadingIcon className="mr-2 size-4" />
                      {t("workspace.settings.deletedConversations.loadingMore")}
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DeletedConversationRow({
  conversation,
  locale,
  operation,
  onDelete,
  onRestore
}: {
  conversation: WorkspaceDeletedConversation;
  locale: DesktopLocale;
  operation: "deleting" | "restoring" | undefined;
  onDelete: () => void;
  onRestore: () => void;
}) {
  const { t } = useTranslation();
  const pending = operation !== undefined;
  const projectDisplayLabel =
    conversation.projectLabel ||
    (conversation.projectPath
      ? projectBasename(conversation.projectPath)
      : conversation.railSectionKey);
  const projectLabel =
    conversation.railSectionKey !== "conversations"
      ? conversation.projectAvailable
        ? projectDisplayLabel
        : t("workspace.settings.deletedConversations.removedProject", {
            project: projectDisplayLabel
          })
      : t("workspace.settings.deletedConversations.unscoped");
  const shortTime = formatConversationTime(
    conversation.updatedAtUnixMs,
    locale,
    false
  );
  const fullTime = formatConversationTime(
    conversation.updatedAtUnixMs,
    locale,
    true
  );

  return (
    <article className="flex h-[60px] min-w-0 items-center gap-3 rounded-md border border-transparent px-3 py-2 transition-colors hover:bg-[var(--transparency-block)]">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-normal leading-[18px] text-[var(--text-primary)]">
          {conversation.title.trim() ||
            t("workspace.settings.deletedConversations.untitled")}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12px] leading-[17px] text-[var(--text-tertiary)]">
          <FolderIcon aria-hidden="true" className="size-3 shrink-0" />
          <span className="min-w-0 truncate">{projectLabel}</span>
          <span aria-hidden="true" className="shrink-0">
            ·
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <time
                className="shrink-0 tabular-nums"
                dateTime={new Date(conversation.updatedAtUnixMs).toISOString()}
              >
                {shortTime}
              </time>
            </TooltipTrigger>
            <TooltipContent side="top">{fullTime}</TooltipContent>
          </Tooltip>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          disabled={pending}
          size="xs"
          variant="destructive-secondary"
          onClick={onDelete}
        >
          {operation === "deleting" ? (
            <LoadingIcon data-icon="inline-start" />
          ) : (
            <DeleteIcon data-icon="inline-start" />
          )}
          {t(
            operation === "deleting"
              ? "workspace.settings.deletedConversations.deleting"
              : "workspace.settings.deletedConversations.deleteAction"
          )}
        </Button>
        {conversation.restorable ? (
          <Button
            disabled={pending}
            size="xs"
            variant="secondary"
            onClick={onRestore}
          >
            {operation === "restoring" ? (
              <LoadingIcon data-icon="inline-start" />
            ) : (
              <RestoreIcon data-icon="inline-start" />
            )}
            {t(
              operation === "restoring"
                ? "workspace.settings.deletedConversations.restoring"
                : "workspace.settings.deletedConversations.restore"
            )}
          </Button>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex" tabIndex={0}>
                <Button disabled size="xs" variant="secondary">
                  <RestoreIcon data-icon="inline-start" />
                  {t("workspace.settings.deletedConversations.restore")}
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">
              {t(
                conversation.unavailableReason === "legacyDataUnavailable"
                  ? "workspace.settings.deletedConversations.legacyRestoreUnavailable"
                  : "workspace.settings.deletedConversations.incompleteRestoreUnavailable"
              )}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </article>
  );
}

function DeletedConversationsEmptyState({
  actionLabel,
  description,
  title,
  onAction
}: {
  actionLabel?: string;
  description: string;
  title: string;
  onAction?: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center">
      <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
        {title}
      </strong>
      <p className="mb-0 mt-1 max-w-[360px] text-[12px] leading-[1.4] text-[var(--text-secondary)]">
        {description}
      </p>
      {actionLabel && onAction ? (
        <Button
          className="mt-3"
          size="sm"
          variant="secondary"
          onClick={onAction}
        >
          {actionLabel}
        </Button>
      ) : null}
    </div>
  );
}

function PermanentDeleteDialog({
  conversation,
  deleting,
  onConfirm,
  onOpenChange
}: {
  conversation: WorkspaceDeletedConversation | null;
  deleting: boolean;
  onConfirm: () => Promise<void>;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open={conversation !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t("workspace.settings.deletedConversations.deleteTitle")}
          </DialogTitle>
          <DialogDescription>
            {t("workspace.settings.deletedConversations.deleteDescription", {
              title:
                conversation?.title.trim() ||
                t("workspace.settings.deletedConversations.untitled")
            })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={deleting}
            variant="destructive"
            onClick={() => void onConfirm()}
          >
            {t(
              deleting
                ? "workspace.settings.deletedConversations.deleting"
                : "workspace.settings.deletedConversations.permanentDelete"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function serializeProjectFilter(
  filter: WorkspaceDeletedConversationProjectFilter
): string {
  return filter.kind === "project"
    ? `project:${filter.railSectionKey}`
    : filter.kind;
}

function deserializeProjectFilter(
  value: string
): WorkspaceDeletedConversationProjectFilter {
  if (value === "all" || value === "unscoped") {
    return { kind: value };
  }
  return { kind: "project", railSectionKey: value.slice("project:".length) };
}

function formatConversationTime(
  unixMs: number,
  locale: DesktopLocale,
  full: boolean
): string {
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    month: full ? "long" : "short",
    year: full ? "numeric" : undefined
  }).format(unixMs);
}

function projectBasename(projectPath: string): string {
  return (
    projectPath
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() || projectPath
  );
}
