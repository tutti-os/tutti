import type { AgentToolCallVM } from "../../../contracts/agentToolCallVM";
import { extractImageGenerationPreview } from "../../../../imageGenerationTool";
import { workspaceFilePathBasename } from "../../../../../actions/workspaceFilePathCandidate";
import type { AgentTaskStepVM } from "../../../contracts/agentTaskItemVM";
import type {
  AgentCommandRenderData,
  AgentCommandStatus,
  AgentImageGenerationRenderData,
  AgentMcpRenderData,
  AgentPlanModeRenderData,
  AgentSearchRenderData,
  AgentSkillRenderData,
  AgentTaskRenderData,
  AgentTodoRenderData,
  AgentToolFallbackText,
  AgentToolSearchRenderData,
  AgentWebFetchRenderData,
  AgentWebSearchRenderData
} from "./agentToolRenderDataTypes";
export type * from "./agentToolRenderDataTypes";
export {
  getFileChangeRenderData,
  type AgentFileChangeRenderData
} from "./agentToolFileChangeRenderData";

export function getCommandRenderData(
  call: AgentToolCallVM
): AgentCommandRenderData {
  const payloadInput = recordValue(call.payload?.input);
  return {
    command: firstString(
      stringValue(call.input?.command),
      stringValue(call.input?.cmd),
      commandArrayToString(call.input?.command),
      stringValue(call.payload?.command),
      stringValue(payloadInput?.command),
      stringValue(payloadInput?.cmd)
    ),
    cwd: firstString(
      stringValue(call.input?.cwd),
      stringValue(payloadInput?.cwd)
    ),
    stdout:
      firstRawString(
        rawStringValue(call.output?.stdout),
        rawStringValue(call.output?.text),
        rawStringValue(call.error?.stdout),
        rawStringValue(call.error?.text)
      ) ?? "",
    stderr:
      firstRawString(
        rawStringValue(call.output?.stderr),
        rawStringValue(call.error?.stderr)
      ) ?? "",
    exitCode:
      numberValue(call.output?.exitCode) ?? numberValue(call.error?.exitCode),
    durationMs:
      durationToMs(call.output?.duration) ??
      numberValue(call.output?.durationMs) ??
      durationToMs(call.error?.duration) ??
      numberValue(call.error?.durationMs),
    status: normalizeCommandStatus(call.statusKind ?? call.status)
  };
}

export function getSearchRenderData(
  call: AgentToolCallVM
): AgentSearchRenderData {
  const canonicalFiles = locationPaths(call.locations);
  const output =
    firstString(
      stringValue(call.output?.text),
      stringValue(call.output?.stdout),
      stringValue(call.summary),
      ""
    ) ?? "";
  const outputLines = output.split("\n").filter(Boolean);
  const mode =
    canonicalFiles.length > 0 && !output
      ? "list_files"
      : searchMode(call.output, output);
  const filenames =
    canonicalFiles.length > 0
      ? canonicalFiles
      : stringArray(call.output?.filenames);
  return {
    query: firstString(
      stringValue(call.input?.pattern),
      stringValue(call.input?.query),
      stringValue(call.input?.search_query),
      stringValue(call.input?.searchQuery),
      stringValue(call.input?.glob)
    ),
    scope: firstString(
      stringValue(call.input?.path),
      stringValue(call.input?.file_path),
      stringValue(call.input?.glob)
    ),
    mode,
    files:
      filenames.length > 0
        ? filenames
        : mode === "list_files"
          ? outputLines
          : [],
    lines: outputLines,
    output,
    error:
      firstString(
        stringValue(call.error?.text),
        stringValue(call.error?.stdout),
        stringValue(call.error?.stderr),
        stringValue(call.error?.message)
      ) ?? ""
  };
}

export function getWebSearchRenderData(
  call: AgentToolCallVM
): AgentWebSearchRenderData {
  const queries = normalizedQueries(
    call.input?.search_query,
    call.input?.searchQuery,
    recordValue(call.input?.action)?.search_query,
    recordValue(call.input?.action)?.searchQuery
  );
  return {
    query: firstString(
      stringValue(call.input?.query),
      stringValue(recordValue(call.input?.action)?.query),
      queries[0] ?? null
    ),
    queries,
    url: firstString(
      stringValue(call.input?.url),
      stringValue(recordValue(call.input?.action)?.url)
    ),
    output:
      firstString(
        stringValue(call.output?.text),
        stringValue(call.output?.stdout)
      ) ?? "",
    error:
      firstString(
        stringValue(call.error?.message),
        stringValue(call.error?.stdout)
      ) ?? ""
  };
}

export function getWebFetchRenderData(
  call: AgentToolCallVM,
  maxContentLength = 3000
): AgentWebFetchRenderData {
  const url = firstString(
    stringValue(call.input?.url),
    stringValue(recordValue(call.input?.action)?.url)
  );
  const content = firstString(
    stringValue(call.output?.text),
    stringValue(call.output?.stdout)
  );
  return {
    url,
    domain: domainForUrl(url),
    content,
    visibleContent: content ? content.slice(0, maxContentLength) : null,
    isTruncated: Boolean(content && content.length > maxContentLength)
  };
}

export function getTodoRenderData(
  call: AgentToolCallVM
): AgentTodoRenderData[] {
  const todos = arrayValue(call.input?.todos);
  if (!todos) {
    return [];
  }
  return todos.flatMap((todo) => {
    const record = recordValue(todo);
    const content = firstString(
      stringValue(record?.content),
      stringValue(record?.text)
    );
    if (!content) {
      return [];
    }
    return [{ content, status: stringValue(record?.status) }];
  });
}

export function getMcpRenderData(call: AgentToolCallVM): AgentMcpRenderData {
  return {
    server: firstString(
      stringValue(call.metadata?.server),
      stringValue(call.metadata?.serverName),
      stringValue(call.metadata?.mcpServer)
    ),
    tool: call.toolName,
    summary: stringValue(call.summary),
    output:
      firstString(
        stringValue(call.output?.text),
        stringValue(call.output?.stdout)
      ) ?? ""
  };
}

export function getToolSearchRenderData(
  call: AgentToolCallVM
): AgentToolSearchRenderData {
  const query = stringValue(call.input?.query);
  const matches =
    arrayValue(call.output?.matches)
      ?.map(stringValue)
      .filter((value): value is string => value !== null) ?? [];
  const totalDeferredTools = numberValue(call.output?.totalDeferredTools);
  const mode: AgentToolSearchRenderData["mode"] = query?.startsWith("select:")
    ? "direct"
    : "search";
  const displayQuery = query?.startsWith("select:")
    ? query.slice("select:".length)
    : query?.startsWith("+")
      ? query.slice(1)
      : query;
  return {
    query,
    displayQuery: displayQuery ?? null,
    mode,
    matches,
    totalDeferredTools
  };
}

export function getPlanModeRenderData(
  call: AgentToolCallVM
): AgentPlanModeRenderData {
  const enterText =
    call.rendererKind === "plan-enter"
      ? firstString(
          stringValue(call.planMode?.plan),
          stringValue(call.output?.text),
          nonEmpty(call.summary),
          "Exploring codebase and designing implementation approach."
        )
      : null;
  const filePath = firstString(
    stringValue(call.input?.filePath),
    stringValue(call.input?.file_path)
  );
  return {
    enterText,
    plan:
      call.rendererKind === "plan-enter"
        ? null
        : firstString(
            stringValue(call.input?.plan),
            stringValue(call.payload?.plan),
            nonEmpty(call.summary)
          ),
    filePath,
    fileName: filePath ? workspaceFilePathBasename(filePath) : null
  };
}

export function getTaskRenderData(call: AgentToolCallVM): AgentTaskRenderData {
  const task = call.task;
  const steps: AgentTaskStepVM[] =
    task?.steps ?? normalizeTaskStepsFromCall(call);
  return {
    title: task?.title ?? call.name,
    status:
      task?.status ??
      stringValue(call.metadata?.taskStatus) ??
      stringValue(call.metadata?.subagentStatus),
    durationText:
      typeof task?.durationMs === "number" && Number.isFinite(task.durationMs)
        ? formatDuration(task.durationMs)
        : null,
    latestStepSummary:
      task?.status === "running" ? (steps.at(-1)?.summary ?? null) : null,
    prompt: firstString(
      stringValue(task?.prompt),
      stringValue(call.input?.prompt),
      stringValue(call.input?.description),
      stringValue(call.payload?.description)
    ),
    childSessionId: firstString(
      stringValue(task?.delegateSessionId),
      stringValue(call.metadata?.childSessionID),
      stringValue(call.metadata?.child_session_id),
      stringValue(call.metadata?.subagentSessionID),
      stringValue(call.metadata?.subagent_session_id),
      stringValue(call.metadata?.subagentAgentId),
      stringValue(call.metadata?.agentId)
    ),
    steps,
    resultMarkdown: firstString(
      stringValue(task?.resultMarkdown),
      firstNonEmptyStructuredText(call.output)
    ),
    errorMarkdown: firstNonEmptyStructuredText(call.error)
  };
}

export function getSkillRenderData(
  call: AgentToolCallVM
): AgentSkillRenderData {
  const success = booleanValue(call.output?.success);
  return {
    skill: firstString(
      stringValue(call.input?.skill),
      stringValue(call.output?.commandName),
      nonEmpty(call.summary)
    ),
    args: stringValue(call.input?.args),
    success,
    statusText:
      success === null
        ? null
        : success
          ? "Skill loaded"
          : "Failed to load skill"
  };
}

export function getImageGenerationRenderData(
  call: AgentToolCallVM
): AgentImageGenerationRenderData {
  const preview = extractImageGenerationPreview({
    toolName: call.toolName,
    displayName: call.name,
    outputSavedPath: stringValue(call.output?.savedPath),
    outputSavedPaths: call.output?.savedPaths,
    outputMimeType: call.output?.imageMimeType,
    outputText: call.output?.text,
    inputPrompt: call.input?.prompt,
    payloadInputPrompt: recordValue(call.payload?.input)?.prompt
  });
  return {
    prompt: preview.prompt,
    imageUri: preview.imageUri,
    mimeType: preview.mimeType
  };
}

export function getToolFallbackText(
  call: AgentToolCallVM
): AgentToolFallbackText {
  return {
    summary: nonEmpty(call.summary),
    input: structuredText(call.input),
    output: structuredText(call.output),
    error: structuredText(call.error)
  };
}

export function isFailedToolCall(call: AgentToolCallVM): boolean {
  if (call.statusKind === "failed") {
    return true;
  }
  const normalized = (call.status ?? "").trim().toLowerCase();
  return normalized === "failed" || normalized === "error";
}

/** Human-readable failure detail for collapsed/expanded tool rows. */
export function getToolCallFailureText(call: AgentToolCallVM): string | null {
  const fallback = getToolFallbackText(call);
  const raw = firstString(
    fallback.error,
    isFailedToolCall(call) ? fallback.output : null
  );
  return unwrapToolUseErrorText(raw);
}

function unwrapToolUseErrorText(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const match = value.match(
    /<tool_use_error>\s*([\s\S]*?)\s*<\/tool_use_error>/i
  );
  const unwrapped = match?.[1]?.trim();
  if (unwrapped) {
    return unwrapped;
  }
  return value.trim() || null;
}

function normalizeTaskStepsFromCall(call: AgentToolCallVM): AgentTaskStepVM[] {
  const steps =
    arrayValue(call.metadata?.steps) ??
    arrayValue(call.output?.steps) ??
    arrayValue(call.payload?.steps) ??
    [];
  return steps.flatMap((value, index) => {
    const step = recordValue(value);
    if (!step) {
      return [];
    }
    const toolName =
      stringValue(step.toolName) ??
      stringValue(step.tool_name) ??
      stringValue(step.name) ??
      null;
    const name = toolName ? humanizeToolName(toolName) : `Step ${index + 1}`;
    const status =
      stringValue(step.status) ??
      stringValue(recordValue(step.toolResult)?.status) ??
      stringValue(recordValue(step.tool_result)?.status) ??
      null;
    const summary =
      firstNonEmptyStructuredText(
        recordValue(step.toolResult),
        recordValue(step.tool_result),
        recordValue(step.toolInput),
        recordValue(step.tool_input)
      ) ?? "";
    return [
      {
        id:
          stringValue(step.toolUseId) ??
          stringValue(step.id) ??
          `step-${index + 1}`,
        turnId: call.turnId,
        name,
        toolName,
        status,
        summary,
        payload: {
          input: recordValue(step.toolInput) ?? recordValue(step.tool_input),
          output: recordValue(step.toolResult) ?? recordValue(step.tool_result),
          error: recordValue(step.toolError) ?? recordValue(step.tool_error)
        },
        tool: null,
        occurredAtUnixMs: null
      }
    ];
  });
}

function humanizeToolName(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\w/, (match) => match.toUpperCase());
}

function firstNonEmptyStructuredText(...values: Array<unknown>): string | null {
  for (const value of values) {
    const text = structuredText(value);
    if (text) {
      return text;
    }
  }
  return null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export function formatAgentToolDurationMs(value: number): string {
  return formatDuration(value);
}

function formatDuration(value: number): string {
  if (value < 1000) {
    return `${value}ms`;
  }
  if (value < 60_000) {
    return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}s`;
  }
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function domainForUrl(url: string | null): string | null {
  if (!url) {
    return null;
  }
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function normalizeCommandStatus(
  value: string | null | undefined
): AgentCommandStatus {
  switch ((value ?? "").trim().toLowerCase()) {
    case "working":
    case "running":
    case "in_progress":
      return "running";
    case "completed":
    case "done":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    default:
      return "unknown";
  }
}

function searchMode(
  output: Record<string, unknown> | null,
  outputText: string
): AgentSearchRenderData["mode"] {
  const mode = stringValue(output?.mode);
  if (
    mode === "files_with_matches" ||
    mode === "content" ||
    mode === "count" ||
    mode === "list_files"
  ) {
    return mode;
  }
  if (stringArray(output?.filenames).length > 0) {
    return "files_with_matches";
  }
  if (outputText.includes(":")) {
    return "content";
  }
  return "unknown";
}

function commandArrayToString(value: unknown): string | null {
  const array = arrayValue(value);
  if (!array) {
    return null;
  }
  const parts = array.flatMap((item) =>
    typeof item === "string" && item.trim() ? [item.trim()] : []
  );
  return parts.length > 0 ? parts.join(" ") : null;
}

function durationToMs(value: unknown): number | null {
  const record = recordValue(value);
  if (!record) {
    return null;
  }
  const secs = numberValue(record.secs) ?? 0;
  const nanos = numberValue(record.nanos) ?? 0;
  if (secs === 0 && nanos === 0) {
    return null;
  }
  return secs * 1000 + nanos / 1_000_000;
}

function structuredText(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  const record = recordValue(value);
  if (!record) {
    return null;
  }
  const preferred = firstString(
    stringValue(record.plan),
    stringValue(record.text),
    stringValue(record.summary),
    stringValue(record.result),
    stringValue(record.message),
    stringValue(record.stdout),
    stringValue(record.stderr),
    stringValue(record.query),
    stringValue(record.path),
    stringValue(record.file),
    stringValue(record.filePath),
    stringValue(record.file_path),
    stringValue(record.url),
    stringValue(record.cmd),
    stringValue(record.command)
  );
  if (preferred) {
    return preferred;
  }
  return null;
}

function firstString(
  ...values: Array<string | null | undefined>
): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function firstRawString(
  ...values: Array<string | null | undefined>
): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return null;
}

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function arrayValue(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function rawStringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function stringArray(value: unknown): string[] {
  const array = arrayValue(value);
  if (!array) {
    return [];
  }
  return array.flatMap((item) =>
    typeof item === "string" && item.trim() ? [item.trim()] : []
  );
}

function normalizedQueries(...values: Array<unknown>): string[] {
  for (const value of values) {
    const queries = stringArray(value);
    if (queries.length > 0) {
      return queries;
    }
  }
  return [];
}

function locationPaths(value: unknown): string[] {
  const locations = arrayValue(value);
  if (!locations) {
    return [];
  }
  const paths = locations.flatMap((location) => {
    const record = recordValue(location);
    if (!record) {
      return [];
    }
    return [
      firstString(
        stringValue(record.path),
        stringValue(record.filePath),
        stringValue(record.file_path)
      )
    ].filter((path): path is string => path !== null);
  });
  return Array.from(new Set(paths));
}
