import { useEffect, useState, type JSX } from "react";
import { ZoomableImage } from "../../../../app/renderer/components/ZoomableImage";
import { cn } from "../../../../app/renderer/lib/utils";
import { resolveWorkspaceImageMimeType } from "@tutti-os/workspace-file-manager/services";
import { translate } from "../../../../i18n/index";
import { useOptionalAgentHostApi } from "../../../../agentActivityHost";
import { resolveImageGenerationPreviewSrc } from "../../../imageGenerationTool";
import type { AgentToolRendererProps } from "./agentToolContentShared";
import { ToolMarkdownBlock, ToolSection } from "./agentToolContentShared";
import { getImageGenerationRenderData } from "./render-data/agentToolRenderData";

export function AgentImageGenerationContent({
  call,
  onLinkClick
}: AgentToolRendererProps): JSX.Element | null {
  "use memo";
  const image = getImageGenerationRenderData(call);
  if (!image.prompt && !image.imageUri) {
    return null;
  }

  return (
    <div className="workspace-agents-status-panel__detail-tool-body">
      {image.prompt ? (
        <ToolSection title={translate("agentHost.agentTool.details.input")}>
          <ToolMarkdownBlock
            content={image.prompt}
            onLinkClick={onLinkClick}
            collapsible
          />
        </ToolSection>
      ) : null}
      {image.imageUri ? (
        <ImageGenerationPreview
          uri={image.imageUri}
          mimeType={image.mimeType}
        />
      ) : null}
    </div>
  );
}

function ImageGenerationPreview({
  uri,
  mimeType
}: {
  uri: string;
  mimeType: string | null;
}): JSX.Element | null {
  "use memo";
  const agentHostApi = useOptionalAgentHostApi();
  const localPath = isLocalImagePath(uri) ? uri.trim() : null;
  const readWorkspaceImage = localPath
    ? agentHostApi?.workspace?.readFile
    : undefined;
  const [src, setSrc] = useState<string | null>(() =>
    !localPath ? resolveImageGenerationPreviewSrc(uri) : null
  );

  useEffect(() => {
    if (!localPath || !readWorkspaceImage) {
      setSrc(resolveImageGenerationPreviewSrc(uri));
      return;
    }

    const resolvedLocalPath = localPath;
    const resolvedReadWorkspaceImage = readWorkspaceImage;
    let canceled = false;
    let objectUrl: string | null = null;
    const resolvedMimeType =
      mimeType?.trim() ||
      resolveWorkspaceImageMimeType(resolvedLocalPath) ||
      "image/png";

    async function loadWorkspaceImage(): Promise<void> {
      try {
        const result = await resolvedReadWorkspaceImage({
          path: resolvedLocalPath
        });
        if (canceled) {
          return;
        }
        const bytes =
          result.bytes instanceof Uint8Array
            ? result.bytes
            : new Uint8Array(result.bytes);
        const arrayBuffer = bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength
        ) as ArrayBuffer;
        objectUrl = URL.createObjectURL(
          new Blob([arrayBuffer], { type: resolvedMimeType })
        );
        setSrc(objectUrl);
      } catch {
        if (!canceled) {
          setSrc(null);
        }
      }
    }

    setSrc(null);
    void loadWorkspaceImage();

    return () => {
      canceled = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [localPath, mimeType, readWorkspaceImage, uri]);

  if (!src) {
    return null;
  }

  return (
    <ToolSection title={translate("agentHost.agentTool.details.output")}>
      <ZoomableImage
        alt={translate("agentHost.agentTool.details.imagePreviewAlt")}
        className={cn(
          "block max-h-[360px] max-w-full rounded-[8px] border border-[var(--line-2)] bg-[var(--background-panel)] object-contain"
        )}
        downloadName={localPath ? localPath.split(/[\\/]/).pop() : "image.png"}
        src={src}
        wrapElement="span"
      />
    </ToolSection>
  );
}

function isLocalImagePath(path: string): boolean {
  const candidate = path.trim();
  return (
    (candidate.length > 1 &&
      candidate.startsWith("/") &&
      !candidate.startsWith("//") &&
      !candidate.includes("://") &&
      !/\s/.test(candidate)) ||
    /^[a-zA-Z]:[\\/]/.test(candidate)
  );
}
