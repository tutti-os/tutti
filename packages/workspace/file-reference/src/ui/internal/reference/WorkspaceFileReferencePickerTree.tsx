import { useEffect, useState, type JSX, type ReactNode } from "react";
import { useComposedInputValue } from "@tutti-os/ui-react-hooks";
import {
  ArrowRightIcon,
  Button,
  CheckIcon,
  FileIcon,
  FolderFilledIcon,
  Input,
  ScrollArea,
  SearchIcon,
  Spinner,
  cn
} from "@tutti-os/ui-system";
import { AddIcon as AddLinedIcon } from "@tutti-os/ui-system/icons";
import type {
  WorkspaceFileReference,
  WorkspaceFileReferenceCopy
} from "../../../contracts/index.ts";
import {
  normalizeDirectoryPath,
  type WorkspaceFileReferenceDirectoryState
} from "../../../react/index.ts";

// 每级缩进 = 箭头列宽(20px)+ 间距(8px),使子级文件图标对齐到父文件夹图标下方。
const workspaceFileReferenceTreeIndent = 28;
const workspaceFileReferenceTreeCollapseDurationMs = 200;

export function WorkspaceFileReferencePickerBrowserPane({
  browseRootEntries,
  copy,
  directoryStateByPath,
  expandedFolderPaths,
  focusedPath,
  isLoading,
  mode,
  searchQuery,
  selectedRefs,
  setSearchQuery,
  visibleEntries,
  onFocusPath,
  onToggleFolder,
  onToggleRef
}: {
  browseRootEntries: readonly WorkspaceFileReference[];
  copy: WorkspaceFileReferenceCopy;
  directoryStateByPath: Record<string, WorkspaceFileReferenceDirectoryState>;
  expandedFolderPaths: Record<string, boolean>;
  focusedPath: string | null;
  isLoading: boolean;
  mode: "browse" | "search";
  searchQuery: string;
  selectedRefs: readonly WorkspaceFileReference[];
  setSearchQuery: (query: string) => void;
  visibleEntries: readonly WorkspaceFileReference[];
  onFocusPath: (path: string) => void;
  onToggleFolder: (entry: WorkspaceFileReference) => void;
  onToggleRef: (entry: WorkspaceFileReference) => void;
}): JSX.Element {
  return (
    <section className="nodrag flex min-h-0 flex-col border-b border-[var(--line-1)] [-webkit-app-region:no-drag] lg:border-r lg:border-b-0">
      <div className="border-b border-[var(--line-1)] p-3">
        <WorkspaceFileReferencePickerSearchInput
          placeholder={copy.t("referencePicker.searchPlaceholder")}
          value={searchQuery}
          onChange={setSearchQuery}
        />
      </div>
      {isLoading ? (
        <WorkspaceFileReferencePickerFeedback>
          <Spinner className="text-[var(--text-secondary)]" size={16} />
        </WorkspaceFileReferencePickerFeedback>
      ) : visibleEntries.length === 0 ? (
        <WorkspaceFileReferencePickerFeedback>
          {mode === "search"
            ? copy.t("referencePicker.emptySearch")
            : copy.t("referencePicker.emptyDirectory")}
        </WorkspaceFileReferencePickerFeedback>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-[2px] p-3">
            {mode === "browse" ? (
              <div className="space-y-0.5">
                {browseRootEntries.map((entry) => (
                  <WorkspaceFileReferencePickerTreeEntry
                    childDepth={1}
                    copy={copy}
                    directoryStateByPath={directoryStateByPath}
                    entry={entry}
                    expandedFolderPaths={expandedFolderPaths}
                    focusedPath={focusedPath}
                    key={entry.path}
                    selectedRefs={selectedRefs}
                    onFocusPath={onFocusPath}
                    onToggleFolder={onToggleFolder}
                    onToggleRef={onToggleRef}
                  />
                ))}
              </div>
            ) : (
              visibleEntries.map((entry) => (
                <WorkspaceFileReferencePickerSearchEntry
                  entry={entry}
                  focused={focusedPath === entry.path}
                  key={entry.path}
                  selected={selectedRefs.some(
                    (item) => item.path === entry.path
                  )}
                  onFocusPath={onFocusPath}
                  onToggleRef={onToggleRef}
                />
              ))
            )}
          </div>
        </ScrollArea>
      )}
    </section>
  );
}

function WorkspaceFileReferencePickerSearchInput({
  onChange,
  placeholder,
  value
}: {
  onChange: (value: string) => void;
  placeholder: string;
  value: string;
}): JSX.Element {
  const searchInput = useComposedInputValue({ onCommit: onChange, value });

  return (
    <div className="relative">
      <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-[var(--text-tertiary)]" />
      <Input
        className="pl-9"
        placeholder={placeholder}
        value={searchInput.value}
        onBlur={searchInput.onBlur}
        onChange={searchInput.onChange}
        onCompositionEnd={searchInput.onCompositionEnd}
        onCompositionStart={searchInput.onCompositionStart}
      />
    </div>
  );
}

function WorkspaceFileReferencePickerTreeEntry({
  childDepth,
  copy,
  directoryStateByPath,
  entry,
  expandedFolderPaths,
  focusedPath,
  selectedRefs,
  onFocusPath,
  onToggleFolder,
  onToggleRef
}: {
  childDepth: number;
  copy: WorkspaceFileReferenceCopy;
  directoryStateByPath: Record<string, WorkspaceFileReferenceDirectoryState>;
  entry: WorkspaceFileReference;
  expandedFolderPaths: Record<string, boolean>;
  focusedPath: string | null;
  selectedRefs: readonly WorkspaceFileReference[];
  onFocusPath: (path: string) => void;
  onToggleFolder: (entry: WorkspaceFileReference) => void;
  onToggleRef: (entry: WorkspaceFileReference) => void;
}): JSX.Element {
  const selected = selectedRefs.some((item) => item.path === entry.path);
  const focused = focusedPath === entry.path;
  const isFolder = entry.kind === "folder";
  const folderKey = normalizeDirectoryPath(entry.path);
  const expanded = expandedFolderPaths[folderKey] ?? false;
  const childState = directoryStateByPath[folderKey];
  const childEntries = childState?.entries ?? [];
  const [shouldRenderChildContent, setShouldRenderChildContent] =
    useState(expanded);

  useEffect(() => {
    if (expanded) {
      setShouldRenderChildContent(true);
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setShouldRenderChildContent(false);
    }, workspaceFileReferenceTreeCollapseDurationMs);

    return () => window.clearTimeout(timeoutId);
  }, [expanded]);

  const shouldBuildChildContent = expanded || shouldRenderChildContent;
  const childContent = shouldBuildChildContent ? (
    childState?.loading ? (
      <div
        className="flex items-center gap-2 px-2 py-2 text-[11px] text-[var(--text-secondary)]"
        style={{
          paddingLeft: `${childDepth * workspaceFileReferenceTreeIndent + 12}px`
        }}
      >
        <Spinner className="text-[var(--text-secondary)]" size={14} />
        <span>{copy.t("referencePicker.loading")}</span>
      </div>
    ) : childEntries.length > 0 ? (
      <div className="space-y-0.5">
        {childEntries.map((childEntry) => (
          <WorkspaceFileReferencePickerTreeEntry
            childDepth={childDepth + 1}
            copy={copy}
            directoryStateByPath={directoryStateByPath}
            entry={childEntry}
            expandedFolderPaths={expandedFolderPaths}
            focusedPath={focusedPath}
            key={childEntry.path}
            selectedRefs={selectedRefs}
            onFocusPath={onFocusPath}
            onToggleFolder={onToggleFolder}
            onToggleRef={onToggleRef}
          />
        ))}
      </div>
    ) : childState?.loaded ? (
      <div
        className="px-2 py-2 text-[11px] text-[var(--text-secondary)]"
        style={{
          paddingLeft: `${childDepth * workspaceFileReferenceTreeIndent + 12}px`
        }}
      >
        {copy.t("referencePicker.emptyDirectory")}
      </div>
    ) : null
  ) : null;

  return (
    <div>
      <div
        className={cn(
          "flex items-center gap-2 rounded-[6px] py-1.5 pr-1 transition-colors",
          "nodrag [-webkit-app-region:no-drag]",
          focused || selected
            ? "bg-transparency-block"
            : "hover:bg-transparency-block"
        )}
        style={{
          paddingLeft: `${(childDepth - 1) * workspaceFileReferenceTreeIndent + 8}px`
        }}
      >
        {isFolder ? (
          <button
            aria-label={resolveWorkspaceFileReferenceLabel(entry)}
            className="nodrag grid size-5 shrink-0 place-items-center rounded-sm text-[var(--text-secondary)] [-webkit-app-region:no-drag] hover:bg-[var(--transparency-hover)]"
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onToggleFolder(entry);
            }}
          >
            <ArrowRightIcon
              className={cn(
                "size-3.5 transition-transform",
                expanded && "rotate-90"
              )}
            />
          </button>
        ) : null}
        <button
          className="nodrag flex min-w-0 flex-1 items-center gap-2 text-left [-webkit-app-region:no-drag]"
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onFocusPath(entry.path);
            if (entry.kind === "folder") {
              onToggleFolder(entry);
            }
          }}
        >
          {isFolder ? (
            <FolderFilledIcon className="size-4 shrink-0 text-[var(--rich-text-folder)]" />
          ) : (
            <FileIcon className="size-4 shrink-0 text-[var(--text-tertiary)]" />
          )}
          <span className="truncate text-[13px] text-[var(--text-primary)]">
            {resolveWorkspaceFileReferenceLabel(entry)}
          </span>
        </button>
        <Button
          aria-label={resolveWorkspaceFileReferenceLabel(entry)}
          aria-pressed={selected}
          size="icon-sm"
          type="button"
          variant="ghost"
          className="nodrag shrink-0 [-webkit-app-region:no-drag]"
          onClick={(event) => {
            event.stopPropagation();
            onFocusPath(entry.path);
            onToggleRef(entry);
          }}
        >
          {selected ? (
            <CheckIcon size={14} />
          ) : (
            <AddLinedIcon className="text-[var(--text-secondary)]" size={16} />
          )}
        </Button>
      </div>
      {isFolder ? (
        <div
          className={cn(
            "grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none",
            expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
            childContent && "mt-[2px]"
          )}
        >
          <div
            aria-hidden={expanded ? undefined : "true"}
            className={cn(
              "min-h-0 overflow-hidden transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none",
              expanded
                ? "translate-y-0 opacity-100"
                : "-translate-y-1 opacity-0"
            )}
            inert={expanded ? undefined : true}
          >
            {childContent}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function WorkspaceFileReferencePickerSearchEntry({
  entry,
  focused,
  selected,
  onFocusPath,
  onToggleRef
}: {
  entry: WorkspaceFileReference;
  focused: boolean;
  selected: boolean;
  onFocusPath: (path: string) => void;
  onToggleRef: (entry: WorkspaceFileReference) => void;
}): JSX.Element {
  const isFolder = entry.kind === "folder";

  return (
    <div
      className={cn(
        "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-[6px] border py-2.5 pr-1 pl-3 transition-colors",
        "nodrag [-webkit-app-region:no-drag]",
        focused || selected
          ? "border-border bg-transparency-block"
          : "border-transparent bg-transparent hover:border-border/70 hover:bg-transparency-block"
      )}
    >
      <button
        className="nodrag flex min-w-0 items-center gap-3 text-left [-webkit-app-region:no-drag]"
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onFocusPath(entry.path);
        }}
      >
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-[var(--transparency-block)] text-[var(--text-tertiary)]">
          {isFolder ? (
            <FolderFilledIcon className="size-4 text-[var(--rich-text-folder)]" />
          ) : (
            <FileIcon className="size-4 text-[var(--text-tertiary)]" />
          )}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[13px] font-medium text-[var(--text-primary)]">
            {resolveWorkspaceFileReferenceLabel(entry)}
          </span>
          <span className="block truncate text-[11px] text-[var(--text-secondary)]">
            {entry.path}
          </span>
        </span>
      </button>
      <Button
        aria-label={resolveWorkspaceFileReferenceLabel(entry)}
        aria-pressed={selected}
        size="icon-sm"
        type="button"
        variant="ghost"
        className="nodrag [-webkit-app-region:no-drag]"
        onClick={(event) => {
          event.stopPropagation();
          onFocusPath(entry.path);
          onToggleRef(entry);
        }}
      >
        {selected ? (
          <CheckIcon size={14} />
        ) : (
          <AddLinedIcon className="text-[var(--text-secondary)]" size={16} />
        )}
      </Button>
    </div>
  );
}

function WorkspaceFileReferencePickerFeedback({
  children
}: {
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="grid min-h-0 flex-1 place-items-center px-4 text-center text-[13px] text-[var(--text-secondary)]">
      {children}
    </div>
  );
}

export function resolveWorkspaceFileReferenceLabel(
  ref: WorkspaceFileReference
): string {
  return (
    ref.displayName || ref.path.split("/").filter(Boolean).at(-1) || ref.path
  );
}
