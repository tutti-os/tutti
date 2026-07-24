import type { AgentActivityRuntime } from "../../agentActivityRuntime";

export interface QueuedPromptImageLoadRequest {
  agentSessionId: string;
  attachmentId: string;
  imageKey: string;
  mimeType: string;
  name: string;
  path: string;
  uri: string;
  hostPath: string;
  assetId: string;
  kind: string;
  uploadStatus: string;
  storagePolicy: string;
  remoteUrl: string;
  runtime: AgentActivityRuntime;
  workspaceId: string;
}

export function queuedPromptImageLoadRequestIdentity(
  request: Omit<QueuedPromptImageLoadRequest, "runtime">
): string {
  return [
    request.imageKey,
    request.workspaceId,
    request.agentSessionId,
    request.attachmentId,
    request.path,
    request.uri,
    request.hostPath,
    request.assetId,
    request.kind,
    request.uploadStatus,
    request.storagePolicy,
    request.mimeType,
    request.name,
    request.remoteUrl
  ].join("\u0000");
}

export function queuedPromptImageHasSafeRemoteUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

export class QueuedPromptImageLoadOwner {
  private canceled = false;

  constructor(
    private readonly request: QueuedPromptImageLoadRequest,
    private readonly onSource: (source: string | null) => void
  ) {}

  start(): void {
    const {
      agentSessionId,
      attachmentId,
      mimeType,
      name,
      path,
      uri,
      hostPath,
      assetId,
      kind,
      uploadStatus,
      storagePolicy,
      runtime,
      workspaceId
    } = this.request;
    const readAsset = async (): Promise<
      { data: string; mimeType: string } | undefined
    > => {
      if (attachmentId) {
        return await runtime.readSessionAttachment?.({
          workspaceId,
          agentSessionId,
          attachmentId
        });
      }
      return await runtime.readPromptAsset?.({
        workspaceId,
        agentSessionId,
        mimeType,
        name,
        path,
        uri,
        hostPath,
        assetId,
        kind,
        uploadStatus,
        storagePolicy
      });
    };
    void readAsset()
      .then((asset) => {
        if (this.canceled || !asset) {
          return;
        }
        this.onSource(`data:${asset.mimeType};base64,${asset.data}`);
      })
      .catch((error: unknown) => {
        if (this.canceled) {
          return;
        }
        this.onSource(null);
        console.warn(
          "[agent-gui]",
          JSON.stringify({
            event: "agent.gui.queued_prompt_image_load_failed",
            level: "warn",
            source: "agent-gui",
            workspaceId,
            details: {
              agentSessionId: agentSessionId || null,
              attachmentId: attachmentId || null,
              path: path || null,
              error: error instanceof Error ? error.message : String(error)
            }
          })
        );
      });
  }

  dispose(): void {
    this.canceled = true;
  }
}
