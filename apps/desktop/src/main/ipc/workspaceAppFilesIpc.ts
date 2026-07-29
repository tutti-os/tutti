import { randomUUID } from "node:crypto";
import {
  desktopIpcChannels,
  type DesktopWorkspaceAppOpenFileRequest
} from "../../shared/contracts/ipc.ts";
import {
  normalizeTuttiExternalFileOpenInput,
  normalizeTuttiExternalFileSelectInput,
  normalizeTuttiExternalPdfPrintHtmlInput,
  normalizeTuttiExternalPermissionRequestInput
} from "@tutti-os/workspace-external-core/core";
import type {
  TuttiExternalFileOpenInput,
  TuttiExternalFileSelectResult
} from "@tutti-os/workspace-external-core/contracts";
import type { DesktopDaemonEndpoint } from "../transport/paths";
import { resolveWorkspaceAppOpenFilePayload } from "../host/workspaceAppFileOpen.ts";
import { registerDesktopIpcHandler } from "./handle.ts";
import {
  createWorkspaceAppUploadContentPutRequest,
  normalizeWorkspaceAppUploadCancelInput,
  normalizeWorkspaceAppUploadCompleteInput,
  normalizeWorkspaceAppUploadPrepareInput,
  requestWorkspaceAppUploadCancel,
  requestWorkspaceAppUploadComplete,
  requestWorkspaceAppUploadPrepare
} from "./workspaceAppFileUpload.ts";
import { requireWorkspaceAppGuestContext } from "./workspaceAppGuestContextRegistry.ts";
import { requestManagedAiModelPermission } from "./workspaceAppManagedModelPermission.ts";
import { printWorkspaceAppHtmlToPdf } from "./workspaceAppPdfPrinting.ts";
import { isRecord } from "./workspaceAppPayloadValidation.ts";
import { requestWorkspaceAppExternalRenderer } from "./workspaceAppRendererBridge.ts";

export function registerWorkspaceAppFilesIpc(input: {
  endpoint: DesktopDaemonEndpoint;
}): void {
  const { endpoint } = input;
  registerDesktopIpcHandler(
    desktopIpcChannels.appExternal.filesSelect,
    async (event, payload) => {
      const context = requireWorkspaceAppGuestContext(event.sender);
      const fileInput = normalizeTuttiExternalFileSelectInput(payload);
      return requestWorkspaceAppExternalRenderer<TuttiExternalFileSelectResult>(
        context,
        {
          appId: context.appID,
          input: fileInput,
          operation: "files.select",
          requestId: randomUUID(),
          workspaceId: context.workspaceID
        }
      );
    }
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.appExternal.filesOpen,
    async (event, payload) => {
      const context = requireWorkspaceAppGuestContext(event.sender);
      const fileInput = normalizeTuttiExternalFileOpenInput(payload);
      const request = toWorkspaceAppOpenFileRequest(fileInput, payload);
      const resolved = await resolveWorkspaceAppOpenFilePayload({
        appId: context.appID,
        request,
        workspaceId: context.workspaceID
      });
      context.ownerWindow.webContents.send(
        desktopIpcChannels.appContext.openFileRequested,
        resolved
      );
    }
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.appExternal.filesUploadPrepare,
    async (event, payload) => {
      const context = requireWorkspaceAppGuestContext(event.sender);
      const fileInput = normalizeWorkspaceAppUploadPrepareInput(payload);
      const session = await requestWorkspaceAppUploadPrepare(
        endpoint,
        context,
        fileInput
      );
      return createWorkspaceAppUploadContentPutRequest(
        endpoint,
        context,
        session.uploadId,
        session.expiresAt
      );
    }
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.appExternal.filesUploadComplete,
    async (event, payload) => {
      const context = requireWorkspaceAppGuestContext(event.sender);
      const fileInput = normalizeWorkspaceAppUploadCompleteInput(payload);
      return requestWorkspaceAppUploadComplete(
        endpoint,
        context,
        fileInput.uploadId
      );
    }
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.appExternal.filesUploadCancel,
    async (event, payload) => {
      const context = requireWorkspaceAppGuestContext(event.sender);
      const fileInput = normalizeWorkspaceAppUploadCancelInput(payload);
      await requestWorkspaceAppUploadCancel(
        endpoint,
        context,
        fileInput.uploadId
      );
    }
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.appExternal.permissionsRequest,
    async (event, payload) => {
      const context = requireWorkspaceAppGuestContext(event.sender);
      const fileInput = normalizeTuttiExternalPermissionRequestInput(payload);
      return requestManagedAiModelPermission(endpoint, context, fileInput);
    }
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.appExternal.pdfPrintHtml,
    async (event, payload) => {
      const context = requireWorkspaceAppGuestContext(event.sender);
      const fileInput = normalizeTuttiExternalPdfPrintHtmlInput(payload);
      return printWorkspaceAppHtmlToPdf(context, fileInput);
    }
  );
}

function toWorkspaceAppOpenFileRequest(
  input: TuttiExternalFileOpenInput,
  payload: unknown
): DesktopWorkspaceAppOpenFileRequest {
  const request: DesktopWorkspaceAppOpenFileRequest = { ...input };
  if (!isRecord(payload)) {
    return request;
  }

  const location = payload.location;
  if (isRecord(location) && typeof location.path === "string") {
    const locationType = location.type;
    if (
      locationType === "app-data-relative" ||
      locationType === "app-package-relative" ||
      locationType === "workspace-relative"
    ) {
      request.location = {
        path: location.path.trim(),
        type: locationType
      };
    }
  }

  if (
    typeof payload.packageVersion === "string" ||
    payload.packageVersion === null
  ) {
    request.packageVersion = payload.packageVersion;
  }

  return request;
}
