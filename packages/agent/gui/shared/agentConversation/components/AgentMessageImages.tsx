import { useEffect, useMemo, useState, type JSX } from "react";
import { LoaderCircle } from "lucide-react";
import { useOptionalAgentActivityRuntime } from "../../../agentActivityRuntime";
import { ZoomableImage } from "../../../app/renderer/components/ZoomableImage";
import styles from "../../../agent-gui/agentGuiNode/AgentGUIConversation.styles";
import type {
  AgentMessageContentVM,
  AgentMessageImageVM
} from "../contracts/agentMessageRowVM";

export function AgentUserImageGrid({
  message
}: {
  message: AgentMessageContentVM;
}): JSX.Element {
  "use memo";
  const images = message.images ?? [];
  const { loadingIds, sources } = useAgentMessageImageSources(images);
  const columnCount = Math.min(Math.max(images.length, 1), 4);
  const thumbnailWidth = images.length === 1 ? "160px" : "80px";
  return (
    <div
      className={styles.userImageGrid}
      style={{
        gridTemplateColumns: `repeat(${columnCount}, ${thumbnailWidth})`
      }}
    >
      {images.map((image) => {
        const src = sources.get(image.id) ?? imageSourceUrl(image);
        const loading = !src && loadingIds.has(image.id);
        return (
          <div key={image.id} className={styles.userImageThumbnail}>
            {src ? (
              <ZoomableImage
                src={src}
                alt={image.name?.trim() || "image"}
                className="block max-h-20 w-full rounded-[7px] object-contain"
                draggable={false}
                downloadName={image.name?.trim() || "image.png"}
              />
            ) : loading ? (
              <div
                className="flex h-20 w-full items-center justify-center bg-[color-mix(in_srgb,var(--text-primary)_6%,transparent)]"
                data-testid="agent-gui-message-image-loading"
              >
                <LoaderCircle
                  aria-hidden="true"
                  className="size-5 animate-spin text-[color-mix(in_srgb,var(--text-primary)_45%,transparent)]"
                  strokeWidth={2}
                />
              </div>
            ) : (
              <div className="h-20 w-full animate-pulse bg-[color-mix(in_srgb,var(--text-primary)_8%,transparent)]" />
            )}
          </div>
        );
      })}
    </div>
  );
}

function useAgentMessageImageSources(images: readonly AgentMessageImageVM[]): {
  loadingIds: ReadonlySet<string>;
  sources: ReadonlyMap<string, string>;
} {
  const runtime = useOptionalAgentActivityRuntime();
  const [sources, setSources] = useState<Map<string, string>>(() => new Map());
  const [loadingIds, setLoadingIds] = useState<Set<string>>(() => new Set());
  const missingImages = useMemo(
    () =>
      images.filter(
        (image) =>
          !imageSourceUrl(image) &&
          !sources.has(image.id) &&
          image.workspaceId &&
          image.agentSessionId &&
          (image.attachmentId || image.path)
      ),
    [images, sources]
  );

  useEffect(() => {
    if (
      (!runtime?.readSessionAttachment && !runtime?.readPromptAsset) ||
      missingImages.length === 0
    ) {
      return;
    }
    let canceled = false;
    for (const image of missingImages) {
      const readImage = image.attachmentId
        ? runtime.readSessionAttachment?.({
            workspaceId: image.workspaceId ?? "",
            agentSessionId: image.agentSessionId,
            attachmentId: image.attachmentId ?? ""
          })
        : runtime.readPromptAsset?.({
            workspaceId: image.workspaceId ?? "",
            agentSessionId: image.agentSessionId,
            mimeType: image.mimeType,
            name: image.name,
            path: image.path,
            uri: image.uri,
            hostPath: image.hostPath,
            assetId: image.assetId,
            kind: image.kind,
            uploadStatus: image.uploadStatus,
            storagePolicy: image.storagePolicy
          });
      if (!readImage) continue;
      setLoadingIds((current) => new Set(current).add(image.id));
      void readImage
        .then((attachment) => {
          if (canceled) return;
          setSources((current) => {
            const next = new Map(current);
            next.set(
              image.id,
              `data:${attachment.mimeType};base64,${attachment.data}`
            );
            return next;
          });
        })
        .catch(() => {})
        .finally(() => {
          if (canceled) return;
          setLoadingIds((current) => {
            const next = new Set(current);
            next.delete(image.id);
            return next;
          });
        });
    }
    return () => {
      canceled = true;
    };
  }, [missingImages, runtime]);

  return { loadingIds, sources };
}

function imageDataUrl(image: AgentMessageImageVM): string | null {
  const data = image.data?.trim() ?? "";
  const mimeType = image.mimeType.trim();
  if (!data || !mimeType) return null;
  return data.startsWith("data:") ? data : `data:${mimeType};base64,${data}`;
}

function imageSourceUrl(image: AgentMessageImageVM): string | null {
  const url = image.url?.trim() ?? "";
  return url || imageDataUrl(image);
}
