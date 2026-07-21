import { describe, expect, it } from "vitest";
import type { TranslateFn } from "../../../i18n/index";
import { agentGUITuttiModeLabels } from "./agentGUITuttiModeLabels";

const translate = ((key: string) => key) as TranslateFn;

describe("agentGUITuttiModeLabels", () => {
  it("projects activation and workflow copy through the shared i18n runtime", () => {
    const labels = agentGUITuttiModeLabels(translate);

    expect(labels.tuttiModeLabel).toBe("agentHost.agentGui.tuttiModeLabel");
    expect(labels.tuttiModeUpdateFailed).toBe(
      "agentHost.agentGui.tuttiModeUpdateFailed"
    );
    expect(labels.tuttiModePlanPanel.taskReview).toBe(
      "agentHost.agentGui.tuttiModePlan.taskReview"
    );
    expect(labels.tuttiModePlanPanel.permissionMode).toBe(
      "agentHost.agentGui.tuttiModePlan.permissionMode"
    );
    expect(labels.tuttiModePlanPanel.reasoningEffort).toBe(
      "agentHost.agentGui.tuttiModePlan.reasoningEffort"
    );
    expect(labels.tuttiModePlanPanel.assignmentOptionsLoading).toBe(
      "agentHost.agentGui.tuttiModePlan.assignmentOptionsLoading"
    );
    expect(labels.tuttiModePlanLoadFailed).toBe(
      "agentHost.agentGui.tuttiModePlan.loadFailed"
    );
  });
});
