import type { AgentTaskStepVM } from "../../../contracts/agentTaskItemVM";

export type AgentCommandStatus = "running" | "completed" | "failed" | "unknown";

export interface AgentCommandRenderData {
  command: string | null;
  cwd: string | null;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number | null;
  status: AgentCommandStatus;
}

export interface AgentSearchRenderData {
  query: string | null;
  scope: string | null;
  mode: "files_with_matches" | "content" | "count" | "list_files" | "unknown";
  files: string[];
  lines: string[];
  output: string;
  error: string;
}

export interface AgentWebSearchRenderData {
  query: string | null;
  queries: string[];
  url: string | null;
  output: string;
  error: string;
}

export interface AgentWebFetchRenderData {
  url: string | null;
  domain: string | null;
  content: string | null;
  visibleContent: string | null;
  isTruncated: boolean;
}

export interface AgentTodoRenderData {
  content: string;
  status: string | null;
}

export interface AgentMcpRenderData {
  server: string | null;
  tool: string | null;
  summary: string | null;
  output: string;
}

export interface AgentToolSearchRenderData {
  query: string | null;
  displayQuery: string | null;
  mode: "direct" | "search";
  matches: string[];
  totalDeferredTools: number | null;
}

export interface AgentPlanModeRenderData {
  enterText: string | null;
  plan: string | null;
  filePath: string | null;
  fileName: string | null;
}

export interface AgentTaskRenderData {
  title: string;
  status: string | null;
  durationText: string | null;
  latestStepSummary: string | null;
  prompt: string | null;
  childSessionId: string | null;
  steps: AgentTaskStepVM[];
  resultMarkdown: string | null;
  errorMarkdown: string | null;
}

export interface AgentSkillRenderData {
  skill: string | null;
  args: string | null;
  success: boolean | null;
  statusText: string | null;
}

export interface AgentImageGenerationRenderData {
  prompt: string | null;
  imageUri: string | null;
  mimeType: string | null;
}

export interface AgentToolFallbackText {
  summary: string | null;
  input: string | null;
  output: string | null;
  error: string | null;
}
