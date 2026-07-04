import { cn } from "@tutti-os/ui-system";
import type {
  DragEvent as ReactDragEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactElement
} from "react";
import { useLayoutEffect, useRef } from "react";
import type { WorkspaceFileManagerI18nRuntime } from "../i18n/workspaceFileManagerI18n.ts";
import { splitWorkspaceFileName } from "../services/workspaceFileManagerModel.ts";
import type {
  WorkspaceFileEntry,
  WorkspaceFileManagerInlineRenameValidation
} from "../services/workspaceFileManagerTypes.ts";
import { WorkspaceFileEntryIcon } from "./WorkspaceFileEntryIcon.tsx";
import {
  workspaceFileManagerIconGridFrameClassName,
  workspaceFileManagerIconGridIconClassName,
  workspaceFileManagerIconGridLayout
} from "./workspaceFileManagerIconGridLayout.ts";

export function WorkspaceFileManagerIconGrid({
  contextMenuEntryPath,
  copy,
  draggable,
  entries,
  iconUrlByCacheKey,
  inlineRenameEntryPath,
  inlineRenameValidation,
  isRenaming,
  moveDragActive,
  moveDragPreviewEntryPath,
  moveDragTargetEntryPath,
  pendingDirectoryPath,
  onEntryIconViewportLeave,
  onEntryIconViewportEnter,
  selectedPath,
  onCancelInlineRename,
  onClearInlineRenameValidation,
  onConfirmInlineRename,
  onContextMenu,
  onDragStart,
  onEntryClick,
  onEntryPointerDown
}: {
  contextMenuEntryPath: string | null;
  copy: WorkspaceFileManagerI18nRuntime;
  draggable: boolean;
  entries: readonly WorkspaceFileEntry[];
  iconUrlByCacheKey?: ReadonlyMap<string, string | null>;
  inlineRenameEntryPath: string | null;
  inlineRenameValidation: WorkspaceFileManagerInlineRenameValidation | null;
  isRenaming: boolean;
  moveDragActive: boolean;
  moveDragPreviewEntryPath: string | null;
  moveDragTargetEntryPath: string | null;
  pendingDirectoryPath: string | null;
  onEntryIconViewportLeave?: (entry: WorkspaceFileEntry) => void;
  onEntryIconViewportEnter?: (entry: WorkspaceFileEntry) => void;
  selectedPath: string | null;
  onCancelInlineRename: () => void;
  onClearInlineRenameValidation: () => void;
  onConfirmInlineRename: (newName: string) => Promise<boolean>;
  onContextMenu: (
    event: ReactMouseEvent<HTMLElement>,
    entry: WorkspaceFileEntry
  ) => void;
  onDragStart?: (entry: WorkspaceFileEntry, dataTransfer: DataTransfer) => void;
  onEntryClick: (entry: WorkspaceFileEntry) => void;
  onEntryPointerDown: (
    entry: WorkspaceFileEntry,
    event: ReactPointerEvent<HTMLElement>
  ) => void;
}): ReactElement {
  return (
    <div
      className="grid auto-rows-min content-start items-start gap-x-2 gap-y-6 px-4 py-4"
      style={{
        gridTemplateColumns: `repeat(auto-fill, minmax(${workspaceFileManagerIconGridLayout.tileMinWidthPx}px, 1fr))`
      }}
    >
      {entries.map((entry) => (
        <WorkspaceFileManagerIconTile
          key={entry.path}
          contextMenuActive={contextMenuEntryPath === entry.path}
          copy={copy}
          draggable={draggable}
          entry={entry}
          iconUrlByCacheKey={iconUrlByCacheKey}
          inlineRenameValidation={
            inlineRenameEntryPath === entry.path ? inlineRenameValidation : null
          }
          isEnteringDirectory={pendingDirectoryPath === entry.path}
          isInlineRenaming={inlineRenameEntryPath === entry.path}
          isRenaming={isRenaming}
          moveDragActive={moveDragActive}
          moveDragSource={moveDragPreviewEntryPath === entry.path}
          moveDragTarget={moveDragTargetEntryPath === entry.path}
          onEntryIconViewportLeave={onEntryIconViewportLeave}
          onEntryIconViewportEnter={onEntryIconViewportEnter}
          selected={selectedPath === entry.path}
          onCancelInlineRename={onCancelInlineRename}
          onClearInlineRenameValidation={onClearInlineRenameValidation}
          onConfirmInlineRename={onConfirmInlineRename}
          onContextMenu={onContextMenu}
          onDragStart={onDragStart}
          onClick={onEntryClick}
          onPointerDown={onEntryPointerDown}
        />
      ))}
    </div>
  );
}

function WorkspaceFileManagerIconTile({
  contextMenuActive,
  copy,
  draggable,
  entry,
  iconUrlByCacheKey,
  inlineRenameValidation,
  isEnteringDirectory,
  isInlineRenaming,
  isRenaming,
  moveDragActive,
  moveDragSource,
  moveDragTarget,
  onEntryIconViewportLeave,
  onEntryIconViewportEnter,
  selected,
  onCancelInlineRename,
  onClearInlineRenameValidation,
  onConfirmInlineRename,
  onContextMenu,
  onDragStart,
  onClick,
  onPointerDown
}: {
  contextMenuActive: boolean;
  copy: WorkspaceFileManagerI18nRuntime;
  draggable: boolean;
  entry: WorkspaceFileEntry;
  iconUrlByCacheKey?: ReadonlyMap<string, string | null>;
  inlineRenameValidation: WorkspaceFileManagerInlineRenameValidation | null;
  isEnteringDirectory: boolean;
  isInlineRenaming: boolean;
  isRenaming: boolean;
  moveDragActive: boolean;
  moveDragSource: boolean;
  moveDragTarget: boolean;
  onEntryIconViewportLeave?: (entry: WorkspaceFileEntry) => void;
  onEntryIconViewportEnter?: (entry: WorkspaceFileEntry) => void;
  selected: boolean;
  onCancelInlineRename: () => void;
  onClearInlineRenameValidation: () => void;
  onConfirmInlineRename: (newName: string) => Promise<boolean>;
  onContextMenu: (
    event: ReactMouseEvent<HTMLElement>,
    entry: WorkspaceFileEntry
  ) => void;
  onDragStart?: (entry: WorkspaceFileEntry, dataTransfer: DataTransfer) => void;
  onClick: (entry: WorkspaceFileEntry) => void;
  onPointerDown: (
    entry: WorkspaceFileEntry,
    event: ReactPointerEvent<HTMLElement>
  ) => void;
}): ReactElement {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const nameParts = splitWorkspaceFileName(entry.name);

  useLayoutEffect(() => {
    if (!selected) {
      return;
    }
    buttonRef.current?.scrollIntoView({
      block: "nearest",
      inline: "nearest"
    });
  }, [selected]);

  const tileClassName = cn(
    "flex min-w-0 max-w-[148px] flex-col items-center gap-1.5 rounded-md border border-transparent px-2 py-2 text-center transition-colors",
    isInlineRenaming
      ? "cursor-default"
      : "cursor-pointer hover:bg-transparency-hover active:bg-[var(--transparency-active)]",
    moveDragActive && "cursor-grabbing",
    selected || contextMenuActive || isInlineRenaming
      ? "border-[var(--border-focus)] bg-transparency-block text-[var(--text-primary)]"
      : "text-[var(--text-secondary)]",
    moveDragSource && "opacity-55",
    moveDragTarget &&
      "bg-[var(--accent-bg)] text-[var(--text-primary)] outline outline-1 -outline-offset-1 outline-[var(--border-focus)]"
  );

  const iconGraphic = (
    <WorkspaceFileEntryIcon
      entry={entry}
      frameClassName={workspaceFileManagerIconGridFrameClassName()}
      iconClassName={workspaceFileManagerIconGridIconClassName()}
      iconUrlByCacheKey={iconUrlByCacheKey}
      isEnteringDirectory={isEnteringDirectory}
      loadingIconClassName="size-7"
      onViewportLeave={onEntryIconViewportLeave}
      onViewportEnter={onEntryIconViewportEnter}
    />
  );

  if (isInlineRenaming) {
    return (
      <div
        aria-label={entry.name}
        className={tileClassName}
        data-workspace-file-entry-path={entry.path}
      >
        {iconGraphic}
        <IconTileRenameInput
          copy={copy}
          entry={entry}
          inlineRenameValidation={inlineRenameValidation}
          isRenaming={isRenaming}
          onCancelInlineRename={onCancelInlineRename}
          onClearInlineRenameValidation={onClearInlineRenameValidation}
          onConfirmInlineRename={onConfirmInlineRename}
        />
      </div>
    );
  }

  return (
    <button
      aria-label={entry.name}
      className={tileClassName}
      data-workspace-file-entry-path={entry.path}
      draggable={draggable}
      ref={buttonRef}
      type="button"
      onClick={() => {
        onClick(entry);
      }}
      onContextMenu={(event) => {
        onContextMenu(event, entry);
      }}
      onDragStart={(event: ReactDragEvent<HTMLElement>) => {
        if (!draggable) {
          event.preventDefault();
          return;
        }
        onDragStart?.(entry, event.dataTransfer);
      }}
      onPointerDown={(event) => {
        onPointerDown(entry, event);
      }}
    >
      {iconGraphic}
      <span className="line-clamp-2 w-full break-all text-[13px] leading-[18px] text-[var(--text-primary)]">
        <span>{nameParts.start}</span>
        {nameParts.end ? <span>{nameParts.end}</span> : null}
      </span>
    </button>
  );
}

function IconTileRenameInput({
  copy,
  entry,
  inlineRenameValidation,
  isRenaming,
  onCancelInlineRename,
  onClearInlineRenameValidation,
  onConfirmInlineRename
}: {
  copy: WorkspaceFileManagerI18nRuntime;
  entry: WorkspaceFileEntry;
  inlineRenameValidation: WorkspaceFileManagerInlineRenameValidation | null;
  isRenaming: boolean;
  onCancelInlineRename: () => void;
  onClearInlineRenameValidation: () => void;
  onConfirmInlineRename: (newName: string) => Promise<boolean>;
}): ReactElement {
  const nameParts = splitWorkspaceFileName(entry.name);
  const hasFileExtension =
    nameParts.end.length > 0 && nameParts.end.startsWith(".");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) {
      return;
    }
    input.focus();
    if (hasFileExtension) {
      input.setSelectionRange(0, nameParts.start.length);
    } else {
      input.select();
    }
  }, [hasFileExtension, nameParts.start.length]);

  const validationMessage =
    inlineRenameValidation === "required"
      ? copy.t("createNameRequired")
      : inlineRenameValidation === "invalid"
        ? copy.t("createNameInvalid")
        : null;

  return (
    <span className="flex w-full min-w-0 flex-col gap-0.5">
      <input
        aria-invalid={inlineRenameValidation !== null}
        aria-label={copy.t("renameLabel")}
        className={cn(
          "w-full min-w-0 rounded-[4px] border border-transparent bg-[var(--transparency-block)] px-1 py-0.5 text-center text-xs text-[var(--text-primary)] outline-none",
          inlineRenameValidation !== null && "border-[var(--state-danger)]"
        )}
        defaultValue={entry.name}
        disabled={isRenaming}
        ref={inputRef}
        onBlur={(event) => {
          void onConfirmInlineRename(event.currentTarget.value);
        }}
        onChange={() => {
          onClearInlineRenameValidation();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void onConfirmInlineRename(event.currentTarget.value);
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            onCancelInlineRename();
          }
        }}
      />
      {validationMessage ? (
        <span className="text-[10px] leading-3 text-[var(--state-danger)]">
          {validationMessage}
        </span>
      ) : null}
    </span>
  );
}
