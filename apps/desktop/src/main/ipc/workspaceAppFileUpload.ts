import type {
  DesktopWorkspaceAppFileUploadCancelInput,
  DesktopWorkspaceAppFileUploadCompleteInput,
  DesktopWorkspaceAppFileUploadPrepareInput,
  DesktopWorkspaceAppFileUploadPrepareResult
} from "../../shared/contracts/ipc.ts";
import { normalizeTuttiExternalFileUploadInput } from "@tutti-os/workspace-external-core/core";
import type { TuttiExternalUploadedFile } from "@tutti-os/workspace-external-core/contracts";
import {
  resolveDesktopDaemonBaseUrl,
  type DesktopDaemonEndpoint
} from "../transport/paths.ts";
import { createAppServerToken } from "./workspaceAppContextToken.ts";
import type { WorkspaceAppGuestContext } from "./workspaceAppContextTypes.ts";
import { isRecord } from "./workspaceAppPayloadValidation.ts";

export async function requestWorkspaceAppUploadPrepare(
  endpoint: DesktopDaemonEndpoint,
  context: WorkspaceAppGuestContext,
  input: DesktopWorkspaceAppFileUploadPrepareInput
): Promise<{ expiresAt: string; uploadId: string }> {
  const baseUrl = resolveDesktopDaemonBaseUrl(endpoint);
  // oxlint-disable-next-line no-restricted-globals -- talks to the local daemon, not outbound
  const response = await fetch(workspaceAppUploadSessionUrl(baseUrl, context), {
    body: JSON.stringify(input),
    headers: {
      Authorization: `Bearer ${endpoint.accessToken}`,
      "Content-Type": "application/json"
    },
    method: "POST"
  });
  if (!response.ok) {
    const message = await readWorkspaceAppUploadError(
      response,
      "Prepare workspace app upload"
    );
    throw new Error(message);
  }
  return normalizeWorkspaceAppUploadPrepareResponse(await response.json());
}

export function createWorkspaceAppUploadContentPutRequest(
  endpoint: DesktopDaemonEndpoint,
  context: WorkspaceAppGuestContext,
  uploadId: string,
  expiresAt: string
): DesktopWorkspaceAppFileUploadPrepareResult {
  const baseUrl = resolveDesktopDaemonBaseUrl(endpoint);
  return {
    expiresAt,
    headers: {
      Authorization: `Bearer ${createAppServerToken(
        endpoint.accessToken,
        context.workspaceID,
        context.appID
      )}`,
      "Content-Type": "application/octet-stream"
    },
    method: "PUT",
    uploadId,
    url: new URL(
      `${workspaceAppUploadSessionPath(context)}/${encodeURIComponent(uploadId)}/content`,
      baseUrl
    ).toString()
  };
}

export async function requestWorkspaceAppUploadComplete(
  endpoint: DesktopDaemonEndpoint,
  context: WorkspaceAppGuestContext,
  uploadId: string
): Promise<TuttiExternalUploadedFile> {
  const baseUrl = resolveDesktopDaemonBaseUrl(endpoint);
  // oxlint-disable-next-line no-restricted-globals -- talks to the local daemon, not outbound
  const response = await fetch(
    new URL(
      `${workspaceAppUploadSessionPath(context)}/${encodeURIComponent(uploadId)}/complete`,
      baseUrl
    ),
    {
      headers: {
        Authorization: `Bearer ${endpoint.accessToken}`
      },
      method: "POST"
    }
  );
  if (!response.ok) {
    const message = await readWorkspaceAppUploadError(
      response,
      "Complete workspace app upload"
    );
    throw new Error(message);
  }
  return normalizeWorkspaceAppUploadCompleteResponse(await response.json());
}

export async function requestWorkspaceAppUploadCancel(
  endpoint: DesktopDaemonEndpoint,
  context: WorkspaceAppGuestContext,
  uploadId: string
): Promise<void> {
  const baseUrl = resolveDesktopDaemonBaseUrl(endpoint);
  // oxlint-disable-next-line no-restricted-globals -- talks to the local daemon, not outbound
  const response = await fetch(
    new URL(
      `${workspaceAppUploadSessionPath(context)}/${encodeURIComponent(uploadId)}`,
      baseUrl
    ),
    {
      headers: {
        Authorization: `Bearer ${endpoint.accessToken}`
      },
      method: "DELETE"
    }
  );
  if (!response.ok) {
    const message = await readWorkspaceAppUploadError(
      response,
      "Cancel workspace app upload"
    );
    throw new Error(message);
  }
}

export function normalizeWorkspaceAppUploadPrepareInput(
  payload: unknown
): DesktopWorkspaceAppFileUploadPrepareInput {
  if (!isRecord(payload)) {
    throw new Error("files.upload prepare input must be an object.");
  }
  const input = normalizeTuttiExternalFileUploadInput(payload);
  if (!input.name) {
    throw new Error("files.upload name is required.");
  }
  if (!input.mimeType) {
    throw new Error("files.upload mimeType is required.");
  }
  if (
    typeof payload.sizeBytes !== "number" ||
    !Number.isFinite(payload.sizeBytes) ||
    payload.sizeBytes < 0
  ) {
    throw new Error("files.upload sizeBytes must be a non-negative number.");
  }
  return {
    purpose: input.purpose,
    name: input.name,
    mimeType: input.mimeType,
    sizeBytes: payload.sizeBytes
  };
}

export function normalizeWorkspaceAppUploadCompleteInput(
  payload: unknown
): DesktopWorkspaceAppFileUploadCompleteInput {
  return { uploadId: normalizeWorkspaceAppUploadID(payload, "complete") };
}

export function normalizeWorkspaceAppUploadCancelInput(
  payload: unknown
): DesktopWorkspaceAppFileUploadCancelInput {
  return { uploadId: normalizeWorkspaceAppUploadID(payload, "cancel") };
}

function workspaceAppUploadSessionUrl(
  baseUrl: string,
  context: WorkspaceAppGuestContext
): URL {
  return new URL(workspaceAppUploadSessionPath(context), baseUrl);
}

function workspaceAppUploadSessionPath(
  context: WorkspaceAppGuestContext
): string {
  return `/v1/workspaces/${encodeURIComponent(context.workspaceID)}/apps/${encodeURIComponent(context.appID)}/uploads`;
}

function normalizeWorkspaceAppUploadID(
  payload: unknown,
  operation: "cancel" | "complete"
): string {
  if (!isRecord(payload)) {
    throw new Error(`files.upload ${operation} input must be an object.`);
  }
  const uploadId =
    typeof payload.uploadId === "string" ? payload.uploadId.trim() : "";
  if (!uploadId) {
    throw new Error("files.upload uploadId is required.");
  }
  return uploadId;
}

function normalizeWorkspaceAppUploadPrepareResponse(value: unknown): {
  expiresAt: string;
  uploadId: string;
} {
  if (
    !isRecord(value) ||
    typeof value.uploadId !== "string" ||
    typeof value.expiresAt !== "string"
  ) {
    throw new Error("Workspace app upload prepare response is invalid.");
  }
  return {
    expiresAt: value.expiresAt,
    uploadId: value.uploadId
  };
}

function normalizeWorkspaceAppUploadCompleteResponse(
  value: unknown
): TuttiExternalUploadedFile {
  if (!isRecord(value)) {
    throw new Error("Workspace app upload complete response is invalid.");
  }
  return normalizeWorkspaceAppUploadedFile(value.file);
}

function normalizeWorkspaceAppUploadedFile(
  value: unknown
): TuttiExternalUploadedFile {
  if (
    !isRecord(value) ||
    typeof value.path !== "string" ||
    typeof value.name !== "string" ||
    typeof value.mimeType !== "string" ||
    typeof value.sha256 !== "string" ||
    typeof value.sizeBytes !== "number" ||
    !Number.isFinite(value.sizeBytes)
  ) {
    throw new Error("Workspace app uploaded file response is invalid.");
  }
  return {
    path: value.path,
    name: value.name,
    mimeType: value.mimeType,
    sizeBytes: value.sizeBytes,
    sha256: value.sha256
  };
}

async function readWorkspaceAppUploadError(
  response: Response,
  operation: string
): Promise<string> {
  try {
    const payload: unknown = await response.json();
    if (isRecord(payload)) {
      if (typeof payload.error === "string") {
        return payload.error;
      }
      if (typeof payload.message === "string") {
        return payload.message;
      }
      if (isRecord(payload.error)) {
        const error = payload.error;
        if (typeof error.developerMessage === "string") {
          return error.developerMessage;
        }
        if (typeof error.message === "string") {
          return error.message;
        }
        if (typeof error.reason === "string") {
          return error.reason;
        }
      }
    }
  } catch {
    // Keep the status fallback when the daemon does not return JSON.
  }
  return `${operation} failed with status ${response.status}.`;
}
