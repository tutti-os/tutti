import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent
} from "react";
import {
  FileTextIcon,
  ImageFileIcon,
  LoadingIcon,
  VideoFileIcon
} from "@tutti-os/ui-system";
import type { WorkspaceFilePreviewActivationTarget } from "@tutti-os/workspace-file-preview";
import { WorkspaceFilePreviewSurface } from "@tutti-os/workspace-file-preview/react";
import type { WorkbenchHostNodeBodyContext } from "@tutti-os/workbench-surface";
import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import type { I18nRuntime } from "@tutti-os/ui-i18n-runtime";
import type { DesktopHostFilesApi } from "@preload/types";
import type { WorkspaceWorkbenchDesktopI18nRuntime } from "@shared/i18n";
import {
  isWorkspaceFilePreviewActivationTarget,
  workspaceFilePreviewActivationType
} from "../services/workspaceFilePreviewLaunch";
import type { WorkspaceFilePreviewSaveRequestSource } from "../services/workspaceFilePreviewSaveRequests";
import {
  createWorkspaceFilePreviewNodeController,
  type WorkspaceFilePreviewNodeController,
  type WorkspaceFilePreviewNodeControllerState
} from "../services/workspaceFilePreviewNodeController";
import {
  resolveWorkspaceFilePreviewNodeFile,
  workspaceFilePreviewNodeFileKey
} from "./workspaceFilePreviewNodeState";

export function WorkspaceFilePreviewNodeBody({
  appI18n,
  context,
  hostFilesApi,
  i18n,
  tuttidClient,
  saveRequestSource,
  workspaceID
}: {
  appI18n: I18nRuntime<string>;
  context: WorkbenchHostNodeBodyContext;
  hostFilesApi: Pick<DesktopHostFilesApi, "readLocalPreviewFile">;
  i18n: WorkspaceWorkbenchDesktopI18nRuntime;
  tuttidClient: Pick<
    TuttidClient,
    "readWorkspaceFilePreview" | "writeWorkspaceFileText"
  >;
  saveRequestSource: WorkspaceFilePreviewSaveRequestSource;
  workspaceID: string;
}): React.JSX.Element {
  const contextRef = useRef(context);
  const pendingControllerDisposalsRef = useRef(
    new Map<
      WorkspaceFilePreviewNodeController,
      ReturnType<typeof globalThis.setTimeout>
    >()
  );
  useEffect(() => {
    contextRef.current = context;
  }, [context]);
  const setNodeRuntimeState = useCallback((nextState: unknown): void => {
    contextRef.current.setNodeRuntimeState(nextState);
  }, []);
  const setSnapshotNodeState = useCallback((nextState: unknown): void => {
    contextRef.current.setSnapshotNodeState(nextState);
  }, []);
  const activationTarget = resolveActivationTarget(context);
  const file = resolveWorkspaceFilePreviewNodeFile(context.node.data);
  const activeFile = file ?? activationTarget;
  const activeFileKey = activeFile
    ? workspaceFilePreviewNodeFileKey(activeFile)
    : null;
  const controller = useMemo(
    () =>
      createWorkspaceFilePreviewNodeController({
        appI18n,
        hostFilesApi,
        i18n,
        initialFile: activeFile,
        tuttidClient,
        onRuntimeStateChange: setNodeRuntimeState,
        onSnapshotStateChange: setSnapshotNodeState,
        workspaceID
      }),
    [
      appI18n,
      hostFilesApi,
      i18n,
      tuttidClient,
      setNodeRuntimeState,
      setSnapshotNodeState,
      workspaceID
    ]
  );
  const [state, setState] = useState<WorkspaceFilePreviewNodeControllerState>(
    () => controller.getSnapshot()
  );

  useEffect(() => {
    const syncPreviewState = (): void => {
      setState(controller.getSnapshot());
    };
    const unsubscribe = controller.subscribe(syncPreviewState);
    syncPreviewState();
    return unsubscribe;
  }, [controller]);

  useEffect(() => {
    controller.setActiveFile(activeFile);
  }, [activeFile, activeFileKey, controller]);

  useEffect(() => {
    const pendingDispose =
      pendingControllerDisposalsRef.current.get(controller);
    if (pendingDispose) {
      globalThis.clearTimeout(pendingDispose);
      pendingControllerDisposalsRef.current.delete(controller);
    }

    return () => {
      const disposeTimer = globalThis.setTimeout(() => {
        pendingControllerDisposalsRef.current.delete(controller);
        controller.dispose();
      }, 0);
      pendingControllerDisposalsRef.current.set(controller, disposeTimer);
    };
  }, [controller]);

  useEffect(
    () =>
      saveRequestSource.subscribe(
        context.node.id,
        () => void controller.saveTextFile()
      ),
    [context.node.id, controller, saveRequestSource]
  );

  if (state.status === "text") {
    return (
      <WorkspaceTextFileEditor
        onChange={(event) => {
          const draft = event.target.value;
          controller.changeDraft(draft);
        }}
        state={state}
      />
    );
  }

  return (
    <WorkspaceFilePreviewSurface
      directoryMessage=""
      emptyMessage={appI18n.t("workspaceFileManager.previewUnsupported")}
      imageAlt={(entry) => entry.name}
      loadingIndicator={
        <LoadingIcon className="mx-auto h-5 w-5 animate-spin" aria-hidden />
      }
      loadingMessage={appI18n.t("workspaceFileManager.previewLoadingLabel")}
      renderIcon={(entry) =>
        entry.fileKind === "image" ? (
          <ImageFileIcon className="h-8 w-8" aria-hidden />
        ) : entry.fileKind === "video" ? (
          <VideoFileIcon className="h-8 w-8" aria-hidden />
        ) : (
          <FileTextIcon className="h-8 w-8" aria-hidden />
        )
      }
      state={state}
      variant="canvas"
    />
  );
}

function WorkspaceTextFileEditor({
  onChange,
  state
}: {
  onChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  state: Extract<WorkspaceFilePreviewNodeControllerState, { status: "text" }>;
}): React.JSX.Element {
  const isSaving = state.saveStatus === "saving";
  const saveError =
    state.saveStatus === "error" && state.message ? state.message : null;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-[var(--background-fronted)]">
      {saveError ? (
        <div className="shrink-0 border-b border-[color-mix(in_srgb,var(--state-danger)_28%,transparent)] bg-[color-mix(in_srgb,var(--state-danger)_10%,var(--background-fronted))] px-3 py-2 text-[11px] leading-[18px] text-[var(--state-danger)]">
          {saveError}
        </div>
      ) : null}
      <textarea
        aria-label={state.entry.name}
        className="h-full min-h-0 min-w-0 resize-none overflow-auto border-0 bg-transparent p-3 font-[var(--tsh-font-mono)] text-[11px] leading-[18px] text-[var(--text-secondary)] outline-none"
        disabled={isSaving}
        onChange={onChange}
        spellCheck={false}
        value={state.draft}
      />
    </div>
  );
}

function resolveActivationTarget(
  context: WorkbenchHostNodeBodyContext
): WorkspaceFilePreviewActivationTarget | null {
  if (
    context.activation?.type !== workspaceFilePreviewActivationType ||
    !isWorkspaceFilePreviewActivationTarget(context.activation.payload)
  ) {
    return null;
  }
  return context.activation.payload;
}
