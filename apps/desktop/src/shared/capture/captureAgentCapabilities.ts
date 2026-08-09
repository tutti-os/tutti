import type { AgentActivityComposerOptions } from "@tutti-os/agent-activity-core";
import type { DesktopCaptureAgentOption } from "../contracts/capture.ts";

export function resolveCaptureAgentCapabilities(
  options: AgentActivityComposerOptions
): DesktopCaptureAgentOption["capabilities"] {
  let imageInput = options.capabilities?.imageInput === true;
  if (imageInput && options.capabilities?.modelImageInputRequired) {
    const model =
      options.effectiveSettings?.model?.trim() ||
      options.effectiveModel?.trim() ||
      "";
    if (
      !model ||
      options.models.find((candidate) => candidate.value === model)
        ?.supportsImageInput !== true
    ) {
      imageInput = false;
    }
  }
  return { imageInput, workspaceReferences: true };
}
