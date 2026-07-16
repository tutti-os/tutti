import type { JSX } from "react";
import { translate } from "../../../../i18n/index";
import { AgentGeneratedImagePreview } from "../AgentGeneratedImagePreview";
import type { AgentToolRendererProps } from "./agentToolContentShared";
import { ToolMarkdownBlock, ToolSection } from "./agentToolContentShared";
import { getImageGenerationRenderData } from "./render-data/agentToolRenderData";

export function AgentImageGenerationContent({
  call,
  onLinkClick
}: AgentToolRendererProps): JSX.Element | null {
  "use memo";
  const image = getImageGenerationRenderData(call);
  if (!image.prompt && !image.imageUri) {
    return null;
  }

  return (
    <div className="workspace-agents-status-panel__detail-tool-body">
      {image.prompt ? (
        <ToolSection title={translate("agentHost.agentTool.details.input")}>
          <ToolMarkdownBlock
            content={image.prompt}
            onLinkClick={onLinkClick}
            collapsible
          />
        </ToolSection>
      ) : null}
      {image.imageUri ? (
        <ToolSection title={translate("agentHost.agentTool.details.output")}>
          <AgentGeneratedImagePreview
            uri={image.imageUri}
            mimeType={image.mimeType}
            alt={translate("agentHost.agentTool.details.imagePreviewAlt")}
            className="block max-h-[360px] max-w-full rounded-[8px] border border-[var(--line-2)] bg-[var(--background-panel)] object-contain"
          />
        </ToolSection>
      ) : null}
    </div>
  );
}
