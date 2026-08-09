import type { AgentPromptContentBlock } from "@tutti-os/agent-activity-core";

const maxCapturePromptBlocks = 9;
const maxCapturePromptImageBase64Chars = 32 * 1024 * 1024;
const maxCapturePromptTextChars = 100_000;

export function normalizeCapturePromptContent(
  content: readonly AgentPromptContentBlock[]
): AgentPromptContentBlock[] {
  if (!Array.isArray(content) || content.length > maxCapturePromptBlocks) {
    throw new Error("Screenshot Agent prompt is invalid");
  }
  const normalized: AgentPromptContentBlock[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      throw new Error("Screenshot Agent prompt is invalid");
    }
    if (block.type === "text") {
      const text = block.text?.trim() ?? "";
      if (text.length > maxCapturePromptTextChars) {
        throw new Error("Screenshot Agent prompt is too long");
      }
      if (text) {
        normalized.push({ text, type: "text" });
      }
      continue;
    }
    if (block.type !== "image") {
      throw new Error("Screenshot Agent prompt contains unsupported content");
    }
    const data = block.data?.trim() ?? "";
    if (
      !data ||
      data.length > maxCapturePromptImageBase64Chars ||
      !/^[A-Za-z0-9+/]+={0,2}$/u.test(data) ||
      (block.mimeType !== "image/png" &&
        block.mimeType !== "image/jpeg" &&
        block.mimeType !== "image/webp")
    ) {
      throw new Error("Screenshot Agent image is invalid");
    }
    normalized.push({
      data,
      mimeType: block.mimeType,
      ...(block.name?.trim() ? { name: block.name.trim() } : {}),
      type: "image"
    });
  }
  if (normalized.length === 0) {
    throw new Error("Screenshot Agent prompt is empty");
  }
  return normalized;
}
