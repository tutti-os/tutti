export type AgentConversationExportInput =
  | {
      format: "markdown";
      suggestedFileName: string;
      content: string;
    }
  | {
      format: "pdf";
      suggestedFileName: string;
      renderSource: "current-renderer";
    };

export type AgentConversationExportResult =
  | { status: "canceled" }
  | { status: "saved"; path: string };

export interface AgentConversationExportDependencies {
  renderPdf: () => Promise<Uint8Array>;
  selectSavePath: (
    format: AgentConversationExportInput["format"],
    suggestedFileName: string
  ) => Promise<string | null>;
  writeFile: (path: string, content: string | Uint8Array) => Promise<void>;
}

export async function saveAgentConversationExport(
  input: AgentConversationExportInput,
  dependencies: AgentConversationExportDependencies
): Promise<AgentConversationExportResult> {
  const path = await dependencies.selectSavePath(
    input.format,
    input.suggestedFileName
  );
  if (!path) return { status: "canceled" };
  const content =
    input.format === "pdf" ? await dependencies.renderPdf() : input.content;
  await dependencies.writeFile(path, content);
  return { status: "saved", path };
}
