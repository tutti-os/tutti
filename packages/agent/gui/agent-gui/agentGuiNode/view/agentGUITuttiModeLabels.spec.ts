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
    expect(labels.tuttiModePlanPanel.configurationReview).toBe(
      "agentHost.agentGui.tuttiModePlan.configurationReview"
    );
    expect(labels.tuttiModePlanLoadFailed).toBe(
      "agentHost.agentGui.tuttiModePlan.loadFailed"
    );
  });
});
