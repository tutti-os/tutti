import { describe, expect, it } from "vitest";
import type {
  AgentActivityComposerOptions,
  AgentActivitySnapshot
} from "@tutti-os/agent-activity-core";
import {
  composerOptionsForTarget,
  composerOptionsLoadingForTarget
} from "./agentGuiController.providerHelpers";
import type { AgentGUIComposerTargetData } from "./agentGuiController.composerPresentation";

const target = {
  agentTargetId: "target-1"
} as AgentGUIComposerTargetData;

describe("composer options target state", () => {
  it("reports loading only before the target has cached options", () => {
    const loadingSnapshot = snapshot({
      composerOptionsLoadStatusByTargetKey: { "target-1": "loading" }
    });
    expect(
      composerOptionsLoadingForTarget({ snapshot: loadingSnapshot, target })
    ).toBe(true);
    expect(
      composerOptionsForTarget({ snapshot: loadingSnapshot, target })
    ).toBe(null);

    const cachedOptions = {} as AgentActivityComposerOptions;
    const refreshingSnapshot = snapshot({
      composerOptionsByTargetKey: { "target-1": cachedOptions },
      composerOptionsLoadStatusByTargetKey: { "target-1": "loading" }
    });
    expect(
      composerOptionsLoadingForTarget({ snapshot: refreshingSnapshot, target })
    ).toBe(false);
    expect(
      composerOptionsForTarget({ snapshot: refreshingSnapshot, target })
    ).toBe(cachedOptions);
  });

  it("does not leave the target loading after a request error", () => {
    expect(
      composerOptionsLoadingForTarget({
        snapshot: snapshot({
          composerOptionsLoadStatusByTargetKey: { "target-1": "error" }
        }),
        target
      })
    ).toBe(false);
  });
});

function snapshot(
  overrides: Partial<AgentActivitySnapshot>
): AgentActivitySnapshot {
  return {
    workspaceId: "workspace-1",
    sessions: [],
    presences: [],
    sessionMessagesById: {},
    ...overrides
  };
}
