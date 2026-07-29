import type { AgentPromptContentBlock } from "@tutti-os/client-tuttid-ts";

export function createMobileActivityCommandId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `mobile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function toTuttidPromptContent(
  blocks: readonly {
    type: string;
    text?: string;
    data?: string;
    url?: string;
    attachmentId?: string;
    mimeType?: string;
    name?: string;
    path?: string;
  }[]
): AgentPromptContentBlock[] {
  return blocks.flatMap((block) => {
    if (block.type === "file") {
      throw new Error("file blocks must be uploaded before mobile submission");
    }
    return [
      {
        ...block,
        type: block.type as AgentPromptContentBlock["type"]
      } as AgentPromptContentBlock
    ];
  });
}
