import type { AgentExternalPromptEntryResolver } from "@tutti-os/agent-gui";
import type { DesktopPlatformApi } from "@preload/types";

export function createDesktopAgentExternalPromptEntryResolver(input: {
  platformApi: Pick<DesktopPlatformApi, "resolveDroppedEntries">;
}): AgentExternalPromptEntryResolver {
  return (files) => {
    let entries: ReturnType<DesktopPlatformApi["resolveDroppedEntries"]>;
    try {
      entries = input.platformApi.resolveDroppedEntries([...files]);
    } catch {
      return files.map((_, sourceIndex) => ({
        disposition: "prepare" as const,
        sourceIndex
      }));
    }

    return files.map((file, sourceIndex) => {
      const entry = entries[sourceIndex];
      const path = entry?.path.trim() ?? "";
      if (!path) {
        return { disposition: "prepare" as const, sourceIndex };
      }
      return {
        disposition: "reference" as const,
        sourceIndex,
        reference: {
          displayName: file.name || undefined,
          hostPath: path,
          kind: entry?.kind ?? "file",
          path
        }
      };
    });
  };
}
