import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement
} from "react";
import { WorkspaceFileReferencePicker } from "@tutti-os/workspace-file-reference/ui";
import type {
  WorkspaceFileReference,
  WorkspaceFileReferenceCopy
} from "@tutti-os/workspace-file-reference/contracts";
import type {
  DesktopWorkspaceAppExternalHostApi,
  DesktopWorkspaceAppExternalHostRequestResult
} from "@preload/types";
import type { DesktopWorkspaceAppExternalRendererRequest } from "@shared/contracts/ipc";
import type { TuttiExternalFileOpenInput } from "@tutti-os/workspace-external-core/contracts";
import { useTranslation } from "@renderer/i18n";
import { useWorkspaceWorkbenchHostService } from "./useWorkspaceWorkbenchHostService";
import { useWorkspaceSettingsService } from "./useWorkspaceSettingsService";

const workspaceFileReferenceLocaleKeyByPickerKey: Record<string, string> = {
  "actions.cancel": "common.cancel",
  "referencePicker.confirm": "agentHost.agentGui.referencePicker.confirm",
  "referencePicker.emptyDirectory":
    "agentHost.agentGui.referencePicker.emptyDirectory",
  "referencePicker.emptySearch":
    "agentHost.agentGui.referencePicker.emptySearch",
  "referencePicker.loading": "agentHost.agentGui.referencePicker.loading",
  "referencePicker.previewBinary":
    "agentHost.agentGui.referencePicker.previewBinary",
  "referencePicker.previewDecodeFailed":
    "agentHost.agentGui.referencePicker.previewDecodeFailed",
  "referencePicker.previewError":
    "agentHost.agentGui.referencePicker.previewError",
  "referencePicker.previewFileTooLarge":
    "agentHost.agentGui.referencePicker.previewFileTooLarge",
  "referencePicker.previewFolder":
    "agentHost.agentGui.referencePicker.previewFolder",
  "referencePicker.previewLoading":
    "agentHost.agentGui.referencePicker.previewLoading",
  "referencePicker.previewTextTooLarge":
    "agentHost.agentGui.referencePicker.previewTextTooLarge",
  "referencePicker.previewUnavailable":
    "agentHost.agentGui.referencePicker.previewUnavailable",
  "referencePicker.previewUnsupported":
    "agentHost.agentGui.referencePicker.previewUnsupported",
  "referencePicker.searchPlaceholder":
    "agentHost.agentGui.referencePicker.searchPlaceholder",
  "referencePicker.selectedCount":
    "agentHost.agentGui.referencePicker.selectedCount",
  "referencePicker.title": "agentHost.agentGui.referencePicker.title"
};

interface WorkspaceAppExternalBridgeProps {
  api?: DesktopWorkspaceAppExternalHostApi;
  openFile: (input: TuttiExternalFileOpenInput) => Promise<void>;
  workspaceId: string;
}

interface PendingFileSelect {
  multiple: boolean;
  resolve: (refs: WorkspaceFileReference[]) => void;
}

export function WorkspaceAppExternalBridge({
  api,
  openFile,
  workspaceId
}: WorkspaceAppExternalBridgeProps): ReactElement | null {
  const hostService = useWorkspaceWorkbenchHostService();
  const { service: settingsService } = useWorkspaceSettingsService();
  const { t } = useTranslation();
  const [pendingFileSelect, setPendingFileSelect] =
    useState<PendingFileSelect | null>(null);
  const pendingFileSelectRef = useRef<PendingFileSelect | null>(null);
  const fileAdapter = useMemo(
    () =>
      hostService.createWorkspaceAppExternalFileReferenceAdapter(workspaceId),
    [hostService, workspaceId]
  );
  const copy = useMemo<WorkspaceFileReferenceCopy>(
    () => ({
      t(key, values) {
        const localeKey =
          workspaceFileReferenceLocaleKeyByPickerKey[key] ?? key;
        return t(localeKey as Parameters<typeof t>[0], values);
      }
    }),
    [t]
  );

  const resolvePendingFileSelect = useCallback(
    (refs: WorkspaceFileReference[]) => {
      const pending = pendingFileSelectRef.current;
      if (!pending) {
        return;
      }
      pendingFileSelectRef.current = null;
      setPendingFileSelect(null);
      pending.resolve(pending.multiple ? refs : refs.slice(0, 1));
    },
    []
  );

  const openFileSelect = useCallback(
    (multiple: boolean) =>
      new Promise<WorkspaceFileReference[]>((resolve) => {
        const pending: PendingFileSelect = { multiple, resolve };
        pendingFileSelectRef.current?.resolve([]);
        pendingFileSelectRef.current = pending;
        setPendingFileSelect(pending);
      }),
    []
  );

  const handleRequest = useCallback(
    async (
      request: DesktopWorkspaceAppExternalRendererRequest
    ): Promise<DesktopWorkspaceAppExternalHostRequestResult> => {
      if (request.workspaceId !== workspaceId) {
        throw new Error("Workspace app external request workspace mismatch.");
      }
      switch (request.operation) {
        case "at.query":
          return hostService.queryWorkspaceAppExternalAt({
            query: request.input,
            workspaceId
          });
        case "files.select":
          return openFileSelect(request.input.multiple === true);
        case "files.open":
          await openFile(request.input);
          return undefined;
        case "settings.open":
          settingsService.openPanel(
            { id: workspaceId },
            {
              ...(request.input.provider || request.input.tab === "models"
                ? { pane: "managed-models" }
                : {}),
              ...(request.input.provider
                ? { provider: request.input.provider }
                : {})
            }
          );
          return undefined;
      }
    },
    [hostService, openFile, openFileSelect, settingsService, workspaceId]
  );

  useEffect(() => {
    if (!api) {
      return undefined;
    }
    return api.onRequest(handleRequest);
  }, [api, handleRequest]);

  useEffect(() => {
    return () => {
      pendingFileSelectRef.current?.resolve([]);
      pendingFileSelectRef.current = null;
    };
  }, []);

  return (
    <WorkspaceFileReferencePicker
      copy={copy}
      fileAdapter={fileAdapter}
      open={pendingFileSelect !== null}
      workspaceId={workspaceId}
      onClose={() => resolvePendingFileSelect([])}
      onConfirm={resolvePendingFileSelect}
    />
  );
}
