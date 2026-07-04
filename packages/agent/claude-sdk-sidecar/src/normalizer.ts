import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

export type ToolState = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  partialInputJson: string;
  started: boolean;
  parentToolUseId?: string;
  steps?: Array<Record<string, unknown>>;
};

type StructuredPatchHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
};

export function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function recordValue(
  value: unknown
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export function contentBlocksFromMessage(
  message: SDKMessage
): Array<Record<string, unknown>> {
  const content = (message as { message?: { content?: unknown } }).message
    ?.content;
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap((block) => {
    const record = recordValue(block);
    return record ? [record] : [];
  });
}

export function sdkContentFromPromptBlocks(
  value: unknown,
  fallbackPrompt: string
): Array<Record<string, unknown>> {
  const content: Array<Record<string, unknown>> = [];
  if (Array.isArray(value)) {
    for (const block of value) {
      const record = recordValue(block);
      if (!record) {
        continue;
      }
      if (record.type === "text") {
        const text = stringValue(record.text);
        if (text) {
          content.push({ type: "text", text });
        }
        continue;
      }
      if (record.type === "image") {
        const mimeType = stringValue(record.mimeType);
        const data = stringValue(record.data);
        if (isSupportedClaudeImageMimeType(mimeType) && data) {
          content.push({
            type: "image",
            source: {
              type: "base64",
              media_type: mimeType,
              data
            }
          });
        }
      }
    }
  }
  if (content.length === 0) {
    const prompt = fallbackPrompt.trim();
    if (prompt) {
      content.push({ type: "text", text: prompt });
    }
  }
  return content;
}

export function parseJSONObject(
  value: string
): Record<string, unknown> | undefined {
  try {
    return recordValue(JSON.parse(value));
  } catch {
    return undefined;
  }
}

export function isToolUseBlock(block: Record<string, unknown>): boolean {
  return (
    block.type === "tool_use" ||
    block.type === "server_tool_use" ||
    block.type === "mcp_tool_use"
  );
}

export function isThinkingBlock(block: Record<string, unknown>): boolean {
  return block.type === "thinking" && typeof block.thinking === "string";
}

export function toolPayload(
  turnId: string,
  tool: ToolState,
  status: "streaming" | "completed" | "failed",
  result?: Record<string, unknown>
): Record<string, unknown> {
  const output = toolResultOutput(result);
  const metadata = toolMetadata(tool, result);
  const payload: Record<string, unknown> = {
    turnId,
    toolCallId: tool.id,
    callId: tool.id,
    toolName: tool.name,
    callType: toolCallType(tool.name),
    name: toolDisplayName(tool.name),
    status,
    input: normalizeToolInput(tool),
    locations: toolLocations(tool.input),
    metadata
  };
  const content = toolContent(tool, result);
  if (content.length > 0) {
    payload.content = content;
  }
  if (output) {
    payload.output = output;
  }
  if (status === "failed") {
    payload.error = output ?? { message: "Claude Code tool call failed" };
  }
  return payload;
}

export function commandEntries(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }
  const commands: Array<Record<string, unknown>> = [];
  const unsupported = new Set([
    "clear",
    "cost",
    "keybindings-help",
    "login",
    "logout",
    "output-style:new",
    "release-notes",
    "todos"
  ]);
  for (const item of value) {
    if (typeof item === "string") {
      const name = item.trim();
      if (name && !unsupported.has(name)) {
        commands.push({ name });
      }
      continue;
    }
    const command = recordValue(item);
    if (!command) {
      continue;
    }
    const rawName = stringValue(command.name);
    if (!rawName || unsupported.has(rawName)) {
      continue;
    }
    const name = rawName.endsWith(" (MCP)")
      ? `mcp:${rawName.replace(" (MCP)", "")}`
      : rawName;
    const entry: Record<string, unknown> = {
      name,
      description: stringValue(command.description)
    };
    const hint = commandArgumentHint(command.argumentHint);
    if (hint) {
      entry.input = { hint };
    }
    commands.push(entry);
  }
  return commands;
}

export function speedFromFastModeState(
  state: unknown
): "fast" | "standard" | undefined {
  if (state === "on") {
    return "fast";
  }
  if (state === "off") {
    return "standard";
  }
  return undefined;
}

function commandArgumentHint(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (Array.isArray(value)) {
    return value
      .flatMap((item) => (typeof item === "string" ? [item.trim()] : []))
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

function toolCallType(toolName: string): string {
  const normalized = toolName.toLowerCase();
  if (
    normalized === "askuserquestion" ||
    normalized === "enterplanmode" ||
    normalized === "exitplanmode"
  ) {
    return "interactive";
  }
  if (normalized === "task" || normalized.includes("agent")) {
    return "subagent";
  }
  if (
    ["bash", "command", "shell", "terminal"].some((item) =>
      normalized.includes(item)
    )
  ) {
    return "command";
  }
  if (
    ["edit", "write", "patch", "file"].some((item) => normalized.includes(item))
  ) {
    return "file_change";
  }
  if (normalized.includes("websearch") || normalized.includes("web_search")) {
    return "web_search";
  }
  if (normalized.includes("mcp")) {
    return "mcp_tool";
  }
  return "tool";
}

export function answersFromInteractivePayload(
  payload: Record<string, unknown>,
  toolInput?: Record<string, unknown>
): Record<string, unknown> {
  const byQuestionId = recordValue(payload.answersByQuestionId);
  if (byQuestionId) {
    return answersByQuestionText(byQuestionId, toolInput);
  }
  const answers = recordValue(payload.answers);
  return answers ?? {};
}

function answersByQuestionText(
  answersByQuestionId: Record<string, unknown>,
  toolInput?: Record<string, unknown>
): Record<string, unknown> {
  const questions = Array.isArray(toolInput?.questions)
    ? toolInput.questions
    : [];
  if (questions.length === 0) {
    return answersByQuestionId;
  }
  const answers: Record<string, unknown> = {};
  questions.forEach((value, index) => {
    const question = recordValue(value);
    const questionText = stringValue(question?.question);
    if (!questionText) {
      return;
    }
    const key = firstNonEmptyString(
      stringValue(question?.id),
      `question-${index + 1}`
    );
    if (!Object.hasOwn(answersByQuestionId, key)) {
      return;
    }
    answers[questionText] = sdkAnswerValue(answersByQuestionId[key]);
  });
  return answers;
}

function sdkAnswerValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean)
      .join(", ");
  }
  return value;
}

function firstNonEmptyString(...values: Array<string | undefined>): string {
  for (const value of values) {
    if (value) {
      return value;
    }
  }
  return "";
}

function toolDisplayName(toolName: string): string {
  if (toolName) {
    return toolName;
  }
  return "Claude Code tool";
}

function normalizeToolInput(tool: ToolState): Record<string, unknown> {
  const input = { ...tool.input };
  if (tool.name && !input.toolName) {
    input.toolName = tool.name;
  }
  return input;
}

function toolResultOutput(
  result?: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (!result) {
    return undefined;
  }
  const content = result.content;
  const output: Record<string, unknown> = {};
  if (typeof content === "string") {
    output.text = content;
  } else if (Array.isArray(content)) {
    output.content = content;
    const text = content
      .map((item) => {
        const record = recordValue(item);
        return record && typeof record.text === "string" ? record.text : "";
      })
      .filter(Boolean)
      .join("\n");
    if (text) {
      output.text = text;
    }
  } else if (content !== undefined) {
    output.content = content;
  }
  const toolResponse = toolResponseFromResult(result);
  if (toolResponse) {
    output.toolResponse = toolResponse;
    const structuredPatch = structuredPatchOutput(toolResponse);
    if (structuredPatch.length > 0) {
      output.structuredPatch = structuredPatch;
    }
    const changes = fileChangesFromStructuredPatch(structuredPatch);
    if (changes.length > 0) {
      output.changes = changes;
    }
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function toolMetadata(
  tool: ToolState,
  result?: Record<string, unknown>
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    adapter: "claude-agent-sdk",
    toolName: tool.name
  };
  const parentToolUseID =
    stringValue(tool.parentToolUseId) ||
    stringValue(tool.input.parent_tool_use_id);
  if (parentToolUseID) {
    metadata.parentToolUseId = parentToolUseID;
  }
  if (tool.steps && tool.steps.length > 0) {
    metadata.steps = tool.steps;
  }
  const subagentLaunch = subagentLaunchMetadata(tool, result);
  if (subagentLaunch) {
    Object.assign(metadata, subagentLaunch);
  }
  const fileChange = fileChangeMetadata(tool);
  if (fileChange) {
    metadata.fileChange = fileChange;
  }
  const toolResponse = toolResponseFromResult(result);
  if (toolResponse) {
    metadata.claudeToolResponse = toolResponse;
  }
  return metadata;
}

function subagentLaunchMetadata(
  tool: ToolState,
  result?: Record<string, unknown>
): Record<string, unknown> | undefined {
  // Nested agent launches stream through the parent query without a locally
  // observed tool_use block, so the tool name may be unknown here. The launch
  // result text is the authoritative signal, not the tool call type.
  const text = toolResultText(result);
  if (!/Async agent launched successfully/i.test(text)) {
    return undefined;
  }
  const agentID =
    lineTokenValue(text, "agentId") ||
    lineTokenValue(text, "agent_id") ||
    jsonStringValue(text, "agentId") ||
    jsonStringValue(text, "agent_id");
  const outputFile =
    lineValue(text, "output_file") ||
    lineValue(text, "outputFile") ||
    jsonStringValue(text, "output_file") ||
    jsonStringValue(text, "outputFile");
  const metadata: Record<string, unknown> = {
    async: true,
    subagentAsync: true,
    taskStatus: "running",
    subagentStatus: "running"
  };
  if (agentID) {
    metadata.subagentAgentId = agentID;
    metadata.agentId = agentID;
  }
  if (outputFile) {
    metadata.outputFile = outputFile;
    metadata.subagentOutputFile = outputFile;
  }
  return metadata;
}

function toolResultText(result?: Record<string, unknown>): string {
  if (!result) {
    return "";
  }
  const output = toolResultOutput(result);
  const outputText = stringValue(output?.text);
  if (outputText) {
    return outputText;
  }
  const content = result.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        const record = recordValue(item);
        return record && typeof record.text === "string" ? record.text : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function lineValue(text: string, key: string): string {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(
    new RegExp(`(?:^|\\n)\\s*${escaped}\\s*:\\s*(.+)`, "i")
  );
  return match?.[1]?.trim() ?? "";
}

function lineTokenValue(text: string, key: string): string {
  const value = lineValue(text, key);
  return value.split(/\s+/u)[0]?.trim() ?? "";
}

function jsonStringValue(text: string, key: string): string {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`"${escaped}"\\s*:\\s*"([^"]+)"`, "i"));
  return match?.[1]?.trim() ?? "";
}

function toolLocations(
  input: Record<string, unknown>
): Array<Record<string, string>> {
  const paths = [
    input.file_path,
    input.path,
    input.notebook_path,
    input.filename
  ].flatMap((item) =>
    typeof item === "string" && item.trim() ? [item.trim()] : []
  );
  return [...new Set(paths)].map((path) => ({ path }));
}

function toolContent(
  tool: ToolState,
  result?: Record<string, unknown>
): Array<Record<string, unknown>> {
  const content: Array<Record<string, unknown>> = [];
  const fileChange = fileChangeMetadata(tool);
  if (fileChange) {
    content.push({ type: "file_change", ...fileChange });
  }
  const output = toolResultOutput(result);
  if (output) {
    content.push({ type: "tool_result", ...output });
  }
  return content;
}

function fileChangeMetadata(
  tool: ToolState
): Record<string, unknown> | undefined {
  if (toolCallType(tool.name) !== "file_change") {
    return undefined;
  }
  const paths = toolLocations(tool.input).map((location) => location.path);
  const metadata: Record<string, unknown> = {
    toolName: tool.name
  };
  if (paths.length > 0) {
    metadata.paths = paths;
  }
  const oldText =
    stringValue(tool.input.old_string) || stringValue(tool.input.oldText);
  const newText =
    stringValue(tool.input.new_string) ||
    stringValue(tool.input.newText) ||
    (tool.name === "Write" ? stringValue(tool.input.content) : "");
  if (oldText) {
    metadata.oldText = oldText;
  }
  if (newText) {
    metadata.newText = newText;
  }
  return Object.keys(metadata).length > 1 ? metadata : undefined;
}

function toolResponseFromResult(
  result?: Record<string, unknown>
): Record<string, unknown> | undefined {
  const meta = recordValue(result?._meta);
  const claudeCode = recordValue(meta?.claudeCode);
  const toolResponse = recordValue(claudeCode?.toolResponse);
  if (toolResponse) {
    return toolResponse;
  }
  return recordValue(result?.tool_response);
}

function structuredPatchOutput(
  toolResponse: Record<string, unknown>
): Array<Record<string, unknown>> {
  const filePath = stringValue(toolResponse.filePath);
  const rawHunks = structuredPatchHunks(toolResponse.structuredPatch);
  if (!filePath || rawHunks.length === 0) {
    return [];
  }
  const diff = unifiedDiffFromStructuredPatch(rawHunks);
  if (!diff) {
    return [];
  }
  return [
    {
      path: filePath,
      filePath,
      kind: toolResponse.type ?? "update",
      change: toolResponse.type ?? "update",
      diff,
      patch: diff
    }
  ];
}

function fileChangesFromStructuredPatch(
  structuredPatch: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  const filePatch = structuredPatch[0];
  if (!filePatch) {
    return [];
  }
  return [
    {
      path: filePatch.path,
      type: filePatch.change,
      diff: filePatch.diff
    }
  ];
}

function structuredPatchHunks(value: unknown): StructuredPatchHunk[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    const hunk = recordValue(item);
    if (!hunk || !Array.isArray(hunk.lines)) {
      return [];
    }
    const lines = hunk.lines.flatMap((line) =>
      typeof line === "string" ? [line] : []
    );
    if (lines.length === 0) {
      return [];
    }
    return [
      {
        oldStart: numberValue(hunk.oldStart),
        oldLines: numberValue(hunk.oldLines),
        newStart: numberValue(hunk.newStart),
        newLines: numberValue(hunk.newLines),
        lines
      }
    ];
  });
}

function unifiedDiffFromStructuredPatch(hunks: StructuredPatchHunk[]): string {
  return hunks
    .map((hunk) => [
      `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
      ...hunk.lines.map(normalizeDiffLine)
    ])
    .flat()
    .join("\n");
}

function normalizeDiffLine(line: string): string {
  if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) {
    return line;
  }
  return ` ${line}`;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isSupportedClaudeImageMimeType(value: string): boolean {
  return (
    value === "image/png" || value === "image/jpeg" || value === "image/webp"
  );
}

export function goalStateFromContentBlocks(
  blocks: ReadonlyArray<Record<string, unknown>>
): Record<string, unknown> | undefined {
  for (const block of blocks) {
    const attachment = goalStatusAttachment(block);
    if (!attachment) {
      continue;
    }
    const objective = stringValue(attachment.condition);
    if (!objective) {
      continue;
    }
    const goal: Record<string, unknown> = {
      objective,
      status: attachment.met === true ? "complete" : "active"
    };
    for (const key of [
      "reason",
      "iterations",
      "durationMs",
      "tokens",
      "sentinel"
    ] as const) {
      if (Object.hasOwn(attachment, key)) {
        goal[key] = attachment[key];
      }
    }
    return goal;
  }
  return undefined;
}

function goalStatusAttachment(
  value: Record<string, unknown>,
  depth = 6
): Record<string, unknown> | undefined {
  if (depth <= 0) {
    return undefined;
  }
  if (stringValue(value.type) === "goal_status") {
    return value;
  }
  const attachment = recordValue(value.attachment);
  if (attachment && stringValue(attachment.type) === "goal_status") {
    return attachment;
  }
  for (const child of Object.values(value)) {
    const nested = goalStatusAttachmentFromUnknown(child, depth - 1);
    if (nested) {
      return nested;
    }
  }
  return undefined;
}

function goalStatusAttachmentFromUnknown(
  value: unknown,
  depth: number
): Record<string, unknown> | undefined {
  const record = recordValue(value);
  if (record) {
    return goalStatusAttachment(record, depth);
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  for (const item of value) {
    const nested = goalStatusAttachmentFromUnknown(item, depth);
    if (nested) {
      return nested;
    }
  }
  return undefined;
}
