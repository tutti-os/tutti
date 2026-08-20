import type { AgentPromptContentBlock } from "../../../shared/contracts/dto";
import type { AgentComposerDraftImage } from "./agentGuiNodeTypes";

export type AgentPromptImageContentBlock = AgentPromptContentBlock & {
  type: "image";
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  attachmentId?: string;
  data?: string;
  path?: string;
};

export function formatAgentComposerDraftBytes(sizeBytes: number): string {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }
  const kib = sizeBytes / 1024;
  if (kib < 1024) {
    return `${kib.toFixed(kib >= 10 ? 0 : 1)} KB`;
  }
  const mib = kib / 1024;
  return `${mib.toFixed(mib >= 10 ? 0 : 1)} MB`;
}

export function agentPromptImageBlockToDraftImage(
  image: AgentPromptImageContentBlock,
  idPrefix: string,
  index: number
): AgentComposerDraftImage {
  return {
    id: `${idPrefix}:image:${index}`,
    name: image.name?.trim() || `image-${index + 1}`,
    mimeType: image.mimeType,
    ...(image.attachmentId ? { attachmentId: image.attachmentId } : {}),
    ...(image.data ? { data: image.data } : {}),
    ...(image.url ? { url: image.url } : {}),
    ...(image.path ? { path: image.path } : {}),
    previewUrl:
      typeof image.data === "string" && image.data
        ? image.data.startsWith("data:")
          ? image.data
          : `data:${image.mimeType};base64,${image.data}`
        : (image.url ?? "")
  };
}
