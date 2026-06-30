import type { PointerEvent } from "react";
import { Button, LoadingIcon, StatusDot } from "@tutti-os/ui-system";
import type { WorkbenchHostNodeHeaderContext } from "@tutti-os/workbench-surface";
import type { WorkspaceWorkbenchDesktopI18nRuntime } from "@shared/i18n";
import { workspaceWorkbenchDesktopI18nKeys } from "@shared/i18n";
import { workspaceTextFileNodeTypeID } from "../services/workspaceFilePreviewLaunch";
import { requestWorkspaceFilePreviewSave } from "../services/workspaceFilePreviewSaveRequests";
import {
  resolveWorkspaceFilePreviewNodeFile,
  resolveWorkspaceFilePreviewTextHeaderState,
  type WorkspaceFilePreviewTextHeaderState
} from "./workspaceFilePreviewNodeState";
import { WorkspaceWorkbenchTrafficLights } from "./WorkspaceWorkbenchTrafficLights.ts";

export function WorkspaceFilePreviewNodeHeader({
  context,
  i18n
}: {
  context: WorkbenchHostNodeHeaderContext;
  i18n: WorkspaceWorkbenchDesktopI18nRuntime;
}): React.JSX.Element {
  const file = resolveWorkspaceFilePreviewNodeFile(context.node.data);
  const textHeaderState = resolveWorkspaceFilePreviewTextHeaderState(
    context.node.data
  );
  const shouldShowTextAccessory =
    context.node.data.typeId === workspaceTextFileNodeTypeID &&
    file?.fileKind === "text";

  const onDragPointerDown = (event: PointerEvent<HTMLElement>): void => {
    context.dragHandleProps.onPointerDown?.(event);
    if (!context.isFocused) {
      context.windowActions.focus();
    }
  };

  return (
    <div className="flex h-full min-h-0 items-center gap-3 bg-[var(--background-fronted)] px-3 pl-4">
      <WorkspaceWorkbenchTrafficLights
        className="nodrag"
        displayMode={context.displayMode}
        i18n={i18n}
        windowActions={context.windowActions}
      />
      <div
        {...context.dragHandleProps}
        className="flex h-full min-w-0 flex-1 cursor-grab items-center gap-2 active:cursor-grabbing"
        onPointerDown={onDragPointerDown}
      >
        <div className="min-w-0 truncate text-[13px] font-semibold text-[var(--text-primary)]">
          {context.node.title}
        </div>
      </div>
      {shouldShowTextAccessory ? (
        <WorkspaceFilePreviewTextHeaderAccessory
          headerState={textHeaderState}
          i18n={i18n}
          nodeId={context.node.id}
        />
      ) : null}
    </div>
  );
}

function WorkspaceFilePreviewTextHeaderAccessory({
  headerState,
  i18n,
  nodeId
}: {
  headerState: WorkspaceFilePreviewTextHeaderState | null;
  i18n: WorkspaceWorkbenchDesktopI18nRuntime;
  nodeId: string;
}): React.JSX.Element {
  const state = headerState ?? {
    canSave: false,
    dirty: false,
    status: "loading" as const
  };
  const isSaving = state.status === "saving";
  const shouldShowSaveButton = state.canSave && (state.dirty || isSaving);
  const statusLabel = resolveHeaderStatusLabel({ i18n, state });
  const statusDotTone = resolveHeaderStatusDotTone(state.status);

  return (
    <div className="nodrag flex min-w-0 shrink-0 items-center gap-2">
      {shouldShowSaveButton ? (
        <Button
          type="button"
          variant="default"
          size="sm"
          disabled={!state.dirty || isSaving}
          onClick={() => {
            requestWorkspaceFilePreviewSave(nodeId);
          }}
        >
          {isSaving ? (
            <LoadingIcon aria-hidden className="h-3.5 w-3.5 animate-spin" />
          ) : null}
          <span>
            {i18n.t(workspaceWorkbenchDesktopI18nKeys.filePreview.save)}
          </span>
        </Button>
      ) : null}
      <div
        className="inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap text-[11px] font-semibold leading-4 text-[var(--text-tertiary)]"
        title={statusLabel}
        data-state={state.status}
      >
        <StatusDot
          tone={statusDotTone}
          size="sm"
          pulse={state.status === "saving"}
        />
        <span className="shrink-0">{statusLabel}</span>
      </div>
    </div>
  );
}

type HeaderStatusDotTone = "amber" | "blue" | "green" | "neutral" | "red";

const headerStatusDotToneByStatus = {
  error: "red",
  loading: "neutral",
  saved: "green",
  saving: "blue",
  unsaved: "amber"
} satisfies Record<
  WorkspaceFilePreviewTextHeaderState["status"],
  HeaderStatusDotTone
>;

function resolveHeaderStatusDotTone(
  status: WorkspaceFilePreviewTextHeaderState["status"]
): HeaderStatusDotTone {
  return headerStatusDotToneByStatus[status];
}

function resolveHeaderStatusLabel(input: {
  i18n: WorkspaceWorkbenchDesktopI18nRuntime;
  state: WorkspaceFilePreviewTextHeaderState;
}): string {
  if (input.state.status === "loading") {
    return input.i18n.t(workspaceWorkbenchDesktopI18nKeys.filePreview.loading);
  }
  if (input.state.status === "saving") {
    return input.i18n.t(workspaceWorkbenchDesktopI18nKeys.filePreview.saving);
  }
  if (input.state.status === "error") {
    return (
      input.state.message ??
      input.i18n.t(workspaceWorkbenchDesktopI18nKeys.filePreview.saveFailed)
    );
  }
  if (input.state.status === "unsaved") {
    return input.i18n.t(workspaceWorkbenchDesktopI18nKeys.filePreview.unsaved);
  }
  return input.i18n.t(workspaceWorkbenchDesktopI18nKeys.filePreview.saved);
}
