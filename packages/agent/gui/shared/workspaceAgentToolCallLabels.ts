export type ToolActivityKind = keyof typeof TOOL_ACTIVITY_KIND_TRANSLATION_KEYS;

export const TOOL_ACTIVITY_KIND_TRANSLATION_KEYS = {
  run_command: "agentHost.agentTool.labels.runCommand",
  read_file: "agentHost.agentTool.labels.readFile",
  write_file: "agentHost.agentTool.labels.writeFile",
  edit_file: "agentHost.agentTool.labels.editFile",
  list_files: "agentHost.agentTool.labels.listFiles",
  search_files: "agentHost.agentTool.labels.searchFiles",
  web_search: "agentHost.agentTool.labels.webSearch",
  web_fetch: "agentHost.agentTool.labels.webFetch",
  apply_patch: "agentHost.agentTool.labels.applyPatch",
  use_tool: "agentHost.agentTool.labels.useTool",
  find_files: "agentHost.agentTool.labels.findFiles",
  read_command_output: "agentHost.agentTool.labels.readCommandOutput",
  stop_command: "agentHost.agentTool.labels.stopCommand",
  read_notebook: "agentHost.agentTool.labels.readNotebook",
  edit_notebook: "agentHost.agentTool.labels.editNotebook",
  update_todos: "agentHost.agentTool.labels.updateTodos",
  delegate_agent: "agentHost.agentTool.labels.delegateAgent",
  thinking: "agentHost.agentTool.labels.thinking",
  responding: "agentHost.agentTool.labels.responding",
  notification: "agentHost.agentTool.labels.notification"
} as const;

export const AGENT_ACTIVITY_KINDS = new Set<ToolActivityKind>([
  "thinking",
  "responding",
  "notification"
]);

export const TOOL_NAME_TRANSLATION_KEYS: Record<string, string> = {
  bash: "agentHost.agentTool.labels.runCommand",
  read: "agentHost.agentTool.labels.readFile",
  write: "agentHost.agentTool.labels.writeFile",
  edit: "agentHost.agentTool.labels.editFile",
  glob: "agentHost.agentTool.labels.findFiles",
  grep: "agentHost.agentTool.labels.searchFiles",
  websearch: "agentHost.agentTool.labels.webSearch",
  webfetch: "agentHost.agentTool.labels.webFetch",
  todowrite: "agentHost.agentTool.labels.updateTodos",
  task: "agentHost.agentTool.labels.delegateAgent",
  currenttask: "agentHost.agentTool.labels.currentIssue",
  agent: "agentHost.agentTool.labels.delegateAgent",
  closeagent: "agentHost.agentTool.labels.closeAgent",
  wait: "agentHost.agentTool.labels.waitAgent"
};

export function legacyKindToToolName(kind: ToolActivityKind): string | null {
  switch (kind) {
    case "run_command":
    case "read_command_output":
    case "stop_command":
      return "Bash";
    case "read_file":
    case "read_notebook":
    case "list_files":
      return "Read";
    case "write_file":
      return "Write";
    case "edit_file":
    case "edit_notebook":
    case "apply_patch":
      return "Edit";
    case "find_files":
      return "Glob";
    case "search_files":
      return "Grep";
    case "web_search":
      return "WebSearch";
    case "web_fetch":
      return "WebFetch";
    case "update_todos":
      return "TodoWrite";
    case "delegate_agent":
      return "Task";
    default:
      return null;
  }
}
