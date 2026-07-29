import { useId, useState, type JSX, type ReactNode } from "react";
import {
  Badge,
  Button,
  FileIcon,
  FolderFilledIcon,
  LoadingIcon
} from "@tutti-os/ui-system";
import { formatWorkspacePreviewByteLimit } from "@tutti-os/workspace-file-preview";
import { WorkspaceFilePreviewSurface as SharedWorkspaceFilePreviewSurface } from "@tutti-os/workspace-file-preview/react";
import type { WorkspaceFilePreviewSurfaceState } from "@tutti-os/workspace-file-preview/react";
import type {
  WorkspaceFileReference,
  WorkspaceFileReferenceCopy
} from "../../../contracts/index.ts";
import type { WorkspaceFileReferencePreviewState } from "../../../react/internal/reference/useWorkspaceFileReferencePickerView.ts";
import { resolveWorkspaceFileReferenceLabel } from "./WorkspaceFileReferencePickerTree.tsx";

const workspaceFileReferencePickerSelectedBadgeClassName =
  "max-w-[14rem] rounded-[4px] border-transparent bg-[var(--transparency-block)] text-[var(--text-primary)]";

export function WorkspaceFileReferencePickerPreviewPane({
  copy,
  focusedEntry,
  mode,
  previewState
}: {
  copy: WorkspaceFileReferenceCopy;
  focusedEntry: WorkspaceFileReference | null;
  mode: "browse" | "search";
  previewState: WorkspaceFileReferencePreviewState;
}): JSX.Element {
  return (
    <aside className="flex shrink-0 flex-col border-t border-[var(--line-1)] bg-[var(--background-fronted)] lg:min-h-0 lg:flex-1 lg:border-t-0">
      <div className="flex min-h-0 flex-1 flex-col p-2">
        {focusedEntry ? (
          <div className="flex min-h-0 flex-col gap-4 lg:flex-1 lg:gap-5">
            <WorkspaceFileReferencePreviewSurface
              copy={copy}
              focusedEntry={focusedEntry}
              previewState={previewState}
            />
            <div className="space-y-2 px-2 lg:space-y-3">
              <div className="space-y-1.5">
                <p className="truncate text-[15px] font-semibold text-[var(--text-primary)]">
                  {resolveWorkspaceFileReferenceLabel(focusedEntry)}
                </p>
                <p className="line-clamp-3 text-[13px] text-[var(--text-secondary)] [overflow-wrap:anywhere]">
                  {focusedEntry.path}
                </p>
              </div>
            </div>
          </div>
        ) : (
          <WorkspaceFileReferencePickerFeedback>
            {mode === "search"
              ? copy.t("referencePicker.emptySearch")
              : copy.t("referencePicker.emptyDirectory")}
          </WorkspaceFileReferencePickerFeedback>
        )}
      </div>
    </aside>
  );
}

function WorkspaceFileReferencePreviewSurface({
  copy,
  focusedEntry,
  previewState
}: {
  copy: WorkspaceFileReferenceCopy;
  focusedEntry: WorkspaceFileReference;
  previewState: WorkspaceFileReferencePreviewState;
}): JSX.Element {
  return (
    <SharedWorkspaceFilePreviewSurface
      directoryMessage={copy.t("referencePicker.previewFolder")}
      emptyMessage={copy.t("referencePicker.previewUnavailable")}
      imageAlt={resolveWorkspaceFileReferenceLabel}
      loadingIndicator={
        <span className="mx-auto grid size-11 place-items-center rounded-[6px] bg-[var(--transparency-block)]">
          <LoadingIcon className="size-4 animate-spin" />
        </span>
      }
      loadingMessage={copy.t("referencePicker.previewLoading")}
      renderIcon={(entry) =>
        entry.kind === "folder" ? (
          <FolderFilledIcon className="mx-auto size-9 text-[var(--rich-text-folder)]" />
        ) : (
          <FileIcon className="mx-auto size-9 text-[var(--text-tertiary)]" />
        )
      }
      state={resolveWorkspaceFileReferenceSurfaceState(
        copy,
        focusedEntry,
        previewState
      )}
      variant="compact"
    />
  );
}

function resolveWorkspaceFileReferenceSurfaceState(
  copy: WorkspaceFileReferenceCopy,
  focusedEntry: WorkspaceFileReference,
  previewState: WorkspaceFileReferencePreviewState
): WorkspaceFilePreviewSurfaceState<WorkspaceFileReference> {
  if (focusedEntry.kind === "folder") {
    return {
      entry: focusedEntry,
      status: "directory" as const
    };
  }

  if (
    !("reference" in previewState) ||
    previewState.reference.path !== focusedEntry.path
  ) {
    return {
      entry: focusedEntry,
      message: focusedEntry.path,
      status: "unsupported" as const
    };
  }

  switch (previewState.status) {
    case "loading":
    case "image":
    case "video":
    case "text":
      return {
        ...previewState,
        entry: focusedEntry
      };
    case "readonly":
      return {
        entry: focusedEntry,
        message: resolveWorkspaceFileReferencePreviewReadonlyMessage(
          copy,
          previewState
        ),
        status: "readonly" as const
      };
    case "error":
      return {
        entry: focusedEntry,
        message: copy.t("referencePicker.previewError"),
        status: "error" as const
      };
    case "unsupported":
      return {
        entry: focusedEntry,
        message: copy.t("referencePicker.previewUnsupported"),
        status: "unsupported" as const
      };
    case "unavailable":
      return {
        entry: focusedEntry,
        message: copy.t("referencePicker.previewUnavailable"),
        status: "unsupported" as const
      };
    case "directory":
      return {
        entry: focusedEntry,
        status: "directory" as const
      };
  }
}

function resolveWorkspaceFileReferencePreviewReadonlyMessage(
  copy: WorkspaceFileReferenceCopy,
  previewState: Extract<
    WorkspaceFileReferencePreviewState,
    { status: "readonly" }
  >
): string {
  switch (previewState.reason) {
    case "binary":
      return copy.t("referencePicker.previewBinary");
    case "decode_failed":
      return copy.t("referencePicker.previewDecodeFailed");
    case "file_too_large":
      return copy.t("referencePicker.previewFileTooLarge", {
        maxSize: formatWorkspacePreviewByteLimit(previewState.maxSizeBytes ?? 0)
      });
    case "text_too_large":
      return copy.t("referencePicker.previewTextTooLarge", {
        maxSize: formatWorkspacePreviewByteLimit(previewState.maxSizeBytes ?? 0)
      });
  }
}

export function WorkspaceFileReferencePickerFooter({
  copy,
  onClose,
  onConfirm,
  selectedRefs
}: {
  copy: WorkspaceFileReferenceCopy;
  onClose: () => void;
  onConfirm: () => void;
  selectedRefs: readonly WorkspaceFileReference[];
}): JSX.Element {
  const selectedRefsTooltipId = useId();
  const [selectedRefsTooltipOpen, setSelectedRefsTooltipOpen] = useState(false);
  const selectedRefsLabel = selectedRefs
    .map((ref) => resolveWorkspaceFileReferenceLabel(ref))
    .join("\n");

  return (
    <div className="nodrag flex flex-col gap-3 border-t border-[var(--line-1)] px-4 py-4 [-webkit-app-region:no-drag] sm:px-6 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex min-w-0 flex-wrap items-center gap-2 lg:flex-1">
        <span className="text-[13px] text-[var(--text-secondary)]">
          {copy.t("referencePicker.selectedCount", {
            count: selectedRefs.length
          })}
        </span>
        {selectedRefs.slice(0, 2).map((ref) => (
          <Badge
            className={workspaceFileReferencePickerSelectedBadgeClassName}
            key={ref.path}
            variant="secondary"
          >
            <span className="truncate">
              {resolveWorkspaceFileReferenceLabel(ref)}
            </span>
          </Badge>
        ))}
        {selectedRefs.length > 2 ? (
          <span
            className="relative inline-flex"
            onBlur={() => setSelectedRefsTooltipOpen(false)}
            onFocus={() => setSelectedRefsTooltipOpen(true)}
            onMouseEnter={() => setSelectedRefsTooltipOpen(true)}
            onMouseLeave={() => setSelectedRefsTooltipOpen(false)}
          >
            <Badge
              asChild
              className={`${workspaceFileReferencePickerSelectedBadgeClassName} cursor-default`}
              variant="secondary"
            >
              <button
                aria-describedby={selectedRefsTooltipId}
                aria-label={selectedRefsLabel}
                type="button"
              >
                +{selectedRefs.length - 2}
              </button>
            </Badge>
            <span
              aria-hidden={!selectedRefsTooltipOpen}
              className="pointer-events-none absolute bottom-[calc(100%+8px)] left-0 z-[var(--z-tooltip,100700)] max-h-[min(20rem,calc(100vh-96px))] w-max max-w-[min(28rem,calc(100vw-32px))] overflow-auto whitespace-pre-line rounded-md border border-[var(--border-1)] bg-[var(--background-fronted)] px-2 py-1 text-left text-[13px] leading-[1.3] text-[var(--text-primary)] shadow-soft transition-opacity duration-100 [overflow-wrap:anywhere]"
              id={selectedRefsTooltipId}
              role="tooltip"
              style={{
                opacity: selectedRefsTooltipOpen ? 1 : 0,
                visibility: selectedRefsTooltipOpen ? "visible" : "hidden"
              }}
            >
              {selectedRefsLabel}
            </span>
          </span>
        ) : null}
      </div>
      <div className="flex w-full items-center justify-end gap-2 lg:w-auto lg:shrink-0">
        <Button
          className="nodrag [-webkit-app-region:no-drag]"
          type="button"
          variant="secondary"
          onClick={onClose}
        >
          {copy.t("actions.cancel")}
        </Button>
        <Button
          className="nodrag [-webkit-app-region:no-drag]"
          disabled={selectedRefs.length === 0}
          type="button"
          onClick={onConfirm}
        >
          {copy.t("referencePicker.confirm")}
        </Button>
      </div>
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
