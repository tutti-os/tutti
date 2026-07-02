export type ParsedTaskNotification = {
  taskId: string;
  toolUseId: string;
  outputFile: string;
  status: string;
  summary: string;
  result: string;
  usage?: Record<string, unknown>;
};

function extractXmlTag(text: string, tag: string): string {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i");
  const match = re.exec(text);
  return match?.[1]?.trim() ?? "";
}

function parseTaskNotificationUsage(
  text: string
): Record<string, unknown> | undefined {
  const usageBlock = extractXmlTag(text, "usage");
  if (!usageBlock) {
    return undefined;
  }
  const totalTokens = extractXmlTag(usageBlock, "subagent_tokens");
  const toolUses = extractXmlTag(usageBlock, "tool_uses");
  const durationMs = extractXmlTag(usageBlock, "duration_ms");
  if (!totalTokens && !toolUses && !durationMs) {
    return undefined;
  }
  return {
    ...(totalTokens ? { total_tokens: Number(totalTokens) || 0 } : {}),
    ...(toolUses ? { tool_uses: Number(toolUses) || 0 } : {}),
    ...(durationMs ? { duration_ms: Number(durationMs) || 0 } : {})
  };
}

export function parseTaskNotification(
  text: string
): ParsedTaskNotification | undefined {
  const trimmed = text.trim();
  if (!trimmed.includes("<task-notification>")) {
    return undefined;
  }
  const taskId = extractXmlTag(trimmed, "task-id");
  const toolUseId = extractXmlTag(trimmed, "tool-use-id");
  const status = extractXmlTag(trimmed, "status");
  if (!toolUseId || !status) {
    return undefined;
  }
  const summary =
    extractXmlTag(trimmed, "summary") ||
    extractXmlTag(trimmed, "result") ||
    "Subagent task completed.";
  const result = extractXmlTag(trimmed, "result");
  const usage = parseTaskNotificationUsage(trimmed);
  return {
    taskId,
    toolUseId,
    outputFile: extractXmlTag(trimmed, "output-file"),
    status,
    summary,
    result,
    ...(usage ? { usage } : {})
  };
}

export function taskNotificationToSystemMessage(
  parsed: ParsedTaskNotification
): Record<string, unknown> {
  return {
    task_id: parsed.taskId || undefined,
    tool_use_id: parsed.toolUseId,
    output_file: parsed.outputFile || undefined,
    status: parsed.status,
    summary: parsed.summary,
    ...(parsed.result ? { result: parsed.result } : {}),
    ...(parsed.usage ? { usage: parsed.usage } : {})
  };
}

export function readUserMessageNotificationText(message: {
  message?: { content?: unknown };
}): string {
  const content = message.message?.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((block) => {
      if (!block || typeof block !== "object" || Array.isArray(block)) {
        return [];
      }
      const record = block as Record<string, unknown>;
      if (record.type !== "text") {
        return [];
      }
      const text = typeof record.text === "string" ? record.text.trim() : "";
      return text ? [text] : [];
    })
    .join("\n");
}

export function readQueuedTaskNotificationPrompt(
  message: Record<string, unknown>
): string {
  const attachment = message.attachment;
  if (
    !attachment ||
    typeof attachment !== "object" ||
    Array.isArray(attachment)
  ) {
    return "";
  }
  const record = attachment as Record<string, unknown>;
  if (record.type !== "queued_command") {
    return "";
  }
  if (record.commandMode !== "task-notification") {
    return "";
  }
  return typeof record.prompt === "string" ? record.prompt : "";
}
