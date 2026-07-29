import type { AgentConversationVM } from "@tutti-os/agent-gui/conversation-projection";
import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import { ObservableService } from "./observableService";

type ConversationImage = NonNullable<
  Extract<
    AgentConversationVM["rows"][number],
    { kind: "message" }
  >["messages"][number]["images"]
>[number];

export interface WorkspaceMediaSnapshot {
  loadingImageIds: readonly string[];
  sourcesByImageId: Readonly<Record<string, string>>;
}

export class WorkspaceMediaService extends ObservableService<WorkspaceMediaSnapshot> {
  readonly _serviceBrand: undefined;
  private readonly loadingImageIds = new Set<string>();
  private readonly sourcesByImageId = new Map<string, string>();
  private snapshot: WorkspaceMediaSnapshot | null = null;
  private disposed = false;

  constructor(
    private readonly workspaceId: string,
    private readonly client: TuttidClient
  ) {
    super();
  }

  sync(conversation: AgentConversationVM | null): void {
    if (this.disposed || !conversation) return;
    let changed = false;
    for (const row of conversation.rows) {
      if (row.kind !== "message") continue;
      for (const message of row.messages) {
        for (const image of message.images ?? []) {
          const inlineSource = imageSource(image);
          if (inlineSource) {
            if (this.sourcesByImageId.get(image.id) !== inlineSource) {
              this.sourcesByImageId.set(image.id, inlineSource);
              changed = true;
            }
            continue;
          }
          const attachmentId = image.attachmentId?.trim();
          if (
            !attachmentId ||
            this.sourcesByImageId.has(image.id) ||
            this.loadingImageIds.has(image.id)
          ) {
            continue;
          }
          this.loadingImageIds.add(image.id);
          changed = true;
          void this.client
            .readWorkspaceAgentSessionAttachment(
              image.workspaceId?.trim() || this.workspaceId,
              image.agentSessionId,
              attachmentId
            )
            .then((attachment) => {
              if (this.disposed) return;
              this.sourcesByImageId.set(
                image.id,
                `data:${attachment.mimeType};base64,${attachment.data}`
              );
            })
            .catch(() => undefined)
            .finally(() => {
              if (this.disposed) return;
              this.loadingImageIds.delete(image.id);
              this.publish();
            });
        }
      }
    }
    if (changed) {
      this.publish();
    }
  }

  getSnapshot = (): WorkspaceMediaSnapshot => {
    if (!this.snapshot) {
      this.snapshot = {
        loadingImageIds: [...this.loadingImageIds],
        sourcesByImageId: Object.fromEntries(this.sourcesByImageId)
      };
    }
    return this.snapshot;
  };

  dispose(): void {
    this.disposed = true;
    this.loadingImageIds.clear();
    this.sourcesByImageId.clear();
    this.snapshot = null;
    this.clearListeners();
  }

  private publish(): void {
    this.snapshot = null;
    this.emitChange();
  }
}

function imageSource(image: ConversationImage): string | null {
  const url = image.url?.trim();
  if (url) return url;
  const data = image.data?.trim();
  const mimeType = image.mimeType.trim();
  if (!data || !mimeType) return null;
  return data.startsWith("data:") ? data : `data:${mimeType};base64,${data}`;
}
