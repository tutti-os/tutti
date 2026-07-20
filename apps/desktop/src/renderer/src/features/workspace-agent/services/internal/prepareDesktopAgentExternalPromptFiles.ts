import type {
  AgentActivityRuntime,
  AgentActivityRuntimePromptContentBlock,
  AgentExternalPromptFilePreparationErrorCode,
  AgentExternalPromptFilePreparationResult,
  AgentExternalPromptFilePreparer,
  AgentPreparedExternalPromptFile
} from "@tutti-os/agent-gui";
import type { DesktopPlatformApi } from "@preload/types";
import {
  DESKTOP_AGENT_PROMPT_FILE_MAX_BYTES,
  DESKTOP_AGENT_PROMPT_FILE_TOO_LARGE_ERROR_CODE
} from "../../../../../../shared/agentPromptAssets.ts";
import { uint8ArrayToBase64 } from "./desktopAgentPromptAssetEncoding.ts";

type ExternalPromptFileContent = AgentActivityRuntimePromptContentBlock & {
  type: "file";
  data?: string;
};

type UploadedPromptFile = AgentActivityRuntimePromptContentBlock & {
  type: "file";
};

type ExternalPromptFileSource =
  | {
      content: ExternalPromptFileContent;
      sourceIndex: number;
      status: "ready";
    }
  | {
      result: AgentExternalPromptFilePreparationResult;
      status: "error";
    };

export function createDesktopAgentExternalPromptFilePreparer(input: {
  agentActivityRuntime: AgentActivityRuntime;
  platformApi: Pick<DesktopPlatformApi, "resolveDroppedEntries">;
  workspaceId: string;
}): AgentExternalPromptFilePreparer {
  return async (files) => {
    let entries: ReturnType<DesktopPlatformApi["resolveDroppedEntries"]>;
    try {
      entries = input.platformApi.resolveDroppedEntries([...files]);
    } catch {
      return files.map((_, sourceIndex) =>
        failedExternalPromptFile(sourceIndex, "preparation_failed")
      );
    }

    const sources = await Promise.all(
      files.map(
        async (file, sourceIndex): Promise<ExternalPromptFileSource> => {
          const entry = entries[sourceIndex];
          if (entry?.kind === "folder") {
            return {
              status: "error",
              result: failedExternalPromptFile(
                sourceIndex,
                "folder_unsupported"
              )
            };
          }
          const hostPath = entry?.path.trim() ?? "";
          if (hostPath) {
            return {
              status: "error",
              result: failedExternalPromptFile(
                sourceIndex,
                "preparation_failed"
              )
            };
          }
          if (file.size > DESKTOP_AGENT_PROMPT_FILE_MAX_BYTES) {
            return {
              status: "error",
              result: failedExternalPromptFile(sourceIndex, "file_too_large")
            };
          }
          try {
            return {
              status: "ready",
              sourceIndex,
              content: {
                type: "file",
                name: file.name || "file",
                ...(file.type ? { mimeType: file.type } : {}),
                data: uint8ArrayToBase64(
                  new Uint8Array(await file.arrayBuffer())
                ),
                ...(Number.isFinite(file.size) ? { sizeBytes: file.size } : {}),
                kind: "file"
              }
            };
          } catch (error) {
            return {
              status: "error",
              result: failedExternalPromptFile(
                sourceIndex,
                preparationErrorCode(error)
              )
            };
          }
        }
      )
    );
    const uploadPromptContent = input.agentActivityRuntime.uploadPromptContent;
    return Promise.all(
      sources.map(async (source) => {
        if (source.status === "error") return source.result;
        if (!uploadPromptContent) {
          return failedExternalPromptFile(
            source.sourceIndex,
            "preparation_failed"
          );
        }
        try {
          const uploaded = await uploadPromptContent({
            content: [source.content],
            workspaceId: input.workspaceId
          });
          const uploadedFile = uploaded.content.find(
            (block): block is UploadedPromptFile => block.type === "file"
          );
          if (!uploadedFile) {
            return failedExternalPromptFile(
              source.sourceIndex,
              "preparation_failed"
            );
          }
          const file = externalPromptFileFromUploaded(
            uploadedFile,
            source.content
          );
          return file
            ? {
                sourceIndex: source.sourceIndex,
                status: "prepared" as const,
                file
              }
            : failedExternalPromptFile(
                source.sourceIndex,
                "preparation_failed"
              );
        } catch (error) {
          return failedExternalPromptFile(
            source.sourceIndex,
            preparationErrorCode(error)
          );
        }
      })
    );
  };
}

function failedExternalPromptFile(
  sourceIndex: number,
  errorCode: AgentExternalPromptFilePreparationErrorCode
): AgentExternalPromptFilePreparationResult {
  return { sourceIndex, status: "error", errorCode };
}

function preparationErrorCode(
  error: unknown
): AgentExternalPromptFilePreparationErrorCode {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "";
  return code === DESKTOP_AGENT_PROMPT_FILE_TOO_LARGE_ERROR_CODE
    ? "file_too_large"
    : "preparation_failed";
}

function externalPromptFileFromUploaded(
  uploaded: UploadedPromptFile,
  source: ExternalPromptFileContent
): AgentPreparedExternalPromptFile | null {
  const path = uploaded.path?.trim() ?? "";
  const url = uploaded.url?.trim() ?? "";
  if (!path && !url) return null;
  const metadata = {
    name: uploaded.name?.trim() || source.name?.trim() || "file",
    ...(uploaded.mimeType?.trim()
      ? { mimeType: uploaded.mimeType.trim() }
      : source.mimeType?.trim()
        ? { mimeType: source.mimeType.trim() }
        : {}),
    ...(uploaded.uri?.trim() ? { uri: uploaded.uri.trim() } : {}),
    ...(uploaded.assetId?.trim() ? { assetId: uploaded.assetId.trim() } : {}),
    ...(uploaded.uploadStatus?.trim()
      ? { uploadStatus: uploaded.uploadStatus.trim() }
      : {}),
    ...(typeof uploaded.sizeBytes === "number"
      ? { sizeBytes: uploaded.sizeBytes }
      : typeof source.sizeBytes === "number"
        ? { sizeBytes: source.sizeBytes }
        : {})
  };
  return path
    ? { ...metadata, path, ...(url ? { url } : {}) }
    : { ...metadata, url };
}
