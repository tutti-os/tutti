import { QueryGeneration } from "./queryGeneration.ts";

type ClaudeHookCallback = (
  input: unknown,
  toolUseID?: string
) => Promise<{ continue: boolean }>;

export function queryGenerationHooks(options: {
  generation: QueryGeneration;
  isActive: () => boolean;
  onPostToolUse: ClaudeHookCallback;
  onTaskLifecycle: ClaudeHookCallback;
}): Record<string, Array<{ hooks: ClaudeHookCallback[] }>> {
  const guarded =
    (callback: ClaudeHookCallback): ClaudeHookCallback =>
    async (input, toolUseID) => {
      if (!options.isActive() || options.generation.revoked) {
        return { continue: false };
      }
      return callback(input, toolUseID);
    };

  return {
    PostToolUse: [{ hooks: [guarded(options.onPostToolUse)] }],
    TaskCreated: [{ hooks: [guarded(options.onTaskLifecycle)] }],
    TaskCompleted: [{ hooks: [guarded(options.onTaskLifecycle)] }]
  };
}
