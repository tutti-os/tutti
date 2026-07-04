import { afterEach, describe, expect, it } from "vitest";
import { setAgentGuiI18nTestLocale } from "../../../i18n/testUtils";
import type { AgentSessionPermissionConfig } from "../../../shared/agentSessionTypes";
import type { AgentGUINodeData } from "../../../types";
import {
  buildNodeDefaultComposerSettings,
  nodeDataFromComposerSettings,
  permissionModeOptions,
  readNodeDefaultDraftPrompt,
  readNodeDefaultDraftSettings
} from "./agentGuiController.composerHelpers";

describe("permissionModeOptions", () => {
  afterEach(() => {
    setAgentGuiI18nTestLocale("en");
  });

  it("localizes codex auto permission through the zh-CN provider label", () => {
    setAgentGuiI18nTestLocale("zh-CN");

    const permissionConfig: AgentSessionPermissionConfig = {
      configurable: true,
      defaultValue: "auto",
      modes: [
        {
          id: "auto",
          label: "Approve for me",
          description: "Ask only when risky actions are detected",
          semantic: "auto"
        }
      ]
    };

    expect(permissionModeOptions("codex", permissionConfig)).toEqual([
      {
        value: "auto",
        label: "替我审批",
        description: "仅对检测到的风险操作请求批准"
      }
    ]);
  });
});

describe("target-keyed composer defaults", () => {
  const baseNodeData: AgentGUINodeData = {
    provider: "codex",
    agentTargetId: "local:codex",
    providerTargetId: null,
    providerTargetRef: null,
    lastActiveAgentSessionId: null,
    composerOverrides: null,
    composerOverridesByAgentTargetId: {
      "local:codex": { model: "target-model" }
    },
    composerOverridesByProvider: {
      codex: { model: "provider-model" }
    }
  };

  it("isolates target composer overrides from provider defaults", () => {
    expect(buildNodeDefaultComposerSettings(baseNodeData).model).toBe(
      "target-model"
    );
    expect(
      buildNodeDefaultComposerSettings({
        ...baseNodeData,
        agentTargetId: "other-target"
      }).model
    ).toBeNull();
    expect(
      buildNodeDefaultComposerSettings({
        ...baseNodeData,
        agentTargetId: null
      }).model
    ).toBe("provider-model");
  });

  it("writes target composer overrides without mutating provider defaults", () => {
    const next = nodeDataFromComposerSettings(baseNodeData, {
      model: "target-new",
      reasoningEffort: null,
      speed: null,
      planMode: false,
      browserUse: true,
      computerUse: true,
      permissionModeId: null
    });

    expect(next.composerOverridesByAgentTargetId?.["local:codex"]?.model).toBe(
      "target-new"
    );
    expect(next.composerOverridesByProvider?.codex?.model).toBe(
      "provider-model"
    );
    expect(next.composerOverrides?.model ?? null).toBeNull();
  });

  it("reads target draft defaults before provider legacy defaults", () => {
    expect(
      readNodeDefaultDraftPrompt({
        data: baseNodeData,
        drafts: {
          "__agent_gui_node_defaults__:codex": "provider draft",
          "__agent_gui_node_defaults__:target:local:codex": "target draft"
        }
      })
    ).toBe("target draft");
    expect(
      readNodeDefaultDraftSettings({
        data: baseNodeData,
        drafts: {
          "__agent_gui_node_defaults__:codex": {
            model: "provider-draft-model",
            reasoningEffort: null,
            speed: null,
            planMode: false,
            browserUse: true,
            computerUse: true,
            permissionModeId: null
          },
          "__agent_gui_node_defaults__:target:local:codex": {
            model: "target-draft-model",
            reasoningEffort: null,
            speed: null,
            planMode: false,
            browserUse: true,
            computerUse: true,
            permissionModeId: null
          }
        }
      }).model
    ).toBe("target-draft-model");
  });

  it("does not read provider or global draft settings for target-backed composers", () => {
    expect(
      readNodeDefaultDraftSettings({
        data: {
          ...baseNodeData,
          composerOverrides: {
            model: "legacy-generic-model",
            permissionModeId: "full-access"
          }
        },
        drafts: {
          "__agent_gui_node_defaults__:codex": {
            model: "provider-draft-model",
            reasoningEffort: null,
            speed: null,
            planMode: false,
            browserUse: true,
            computerUse: true,
            permissionModeId: "auto"
          },
          __agent_gui_node_defaults__: {
            model: "global-draft-model",
            reasoningEffort: null,
            speed: null,
            planMode: false,
            browserUse: true,
            computerUse: true,
            permissionModeId: "full-access"
          }
        }
      })
    ).toMatchObject({
      model: "target-model",
      permissionModeId: null
    });
  });
});
