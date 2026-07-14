import { afterEach, describe, expect, it } from "vitest";
import { setAgentGuiI18nTestLocale } from "../../../i18n/testUtils";
import type { AgentSessionPermissionConfig } from "../../../shared/agentSessionTypes";
import type { AgentGUINodeData } from "../../../types";
import {
  buildNodeDefaultComposerSettings,
  slashCommandPoliciesEqual,
  nodeDataFromComposerSettings,
  permissionModeOptions,
  providerSkillsFromComposerOptions,
  readNodeDefaultDraftSettings,
  reasoningSelectionFromComposerOptions
} from "./agentGuiController.composerHelpers";
import type { AgentActivityComposerOptions } from "@tutti-os/agent-activity-core";

describe("slash command policy equality", () => {
  const policy = {
    fallbackCommands: ["compact", "goal"],
    commandEffects: [
      { command: "compact", effect: "submitImmediate" as const },
      { command: "goal", effect: "activateGoalMode" as const }
    ]
  };

  it("compares cloned policy values structurally", () => {
    expect(slashCommandPoliciesEqual(policy, structuredClone(policy))).toBe(
      true
    );
    expect(
      slashCommandPoliciesEqual(policy, {
        ...structuredClone(policy),
        commandEffects: [
          { command: "compact", effect: "submitImmediate" },
          { command: "goal", effect: "showStatus" }
        ]
      })
    ).toBe(false);
    expect(
      slashCommandPoliciesEqual(policy, {
        ...structuredClone(policy),
        commandCatalogAuthoritative: true
      })
    ).toBe(false);
  });
});

describe("descriptor-backed skill invocation", () => {
  it("does not apply invocation metadata from unavailable capabilities", () => {
    const options = {
      skills: [
        {
          name: "example",
          trigger: "/example",
          sourceKind: "plugin"
        }
      ],
      capabilityCatalog: [
        {
          name: "example",
          label: "Example",
          kind: "skill",
          status: "unavailable",
          trigger: "/example",
          invocation: "promptItem"
        }
      ]
    } as unknown as AgentActivityComposerOptions;

    expect(
      providerSkillsFromComposerOptions(options)[0]?.invocation
    ).toBeUndefined();
  });
});

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

describe("model reasoning options", () => {
  afterEach(() => {
    setAgentGuiI18nTestLocale("en");
  });

  const composerOptions = {
    provider: "codex",
    models: [
      { value: "gpt-5.6-sol", label: "GPT-5.6-Sol" },
      { value: "gpt-5.6-luna", label: "GPT-5.6-Luna" }
    ],
    reasoningEfforts: [{ value: "high", label: "High" }],
    speeds: [],
    skills: [],
    reasoningOptionsByModel: {
      "gpt-5.6-sol": {
        defaultValue: "low",
        options: [
          { value: "low", label: "Low" },
          { value: "ultra", label: "ultra" }
        ]
      },
      "gpt-5.6-luna": {
        defaultValue: "medium",
        options: [
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" }
        ]
      },
      "no-reasoning": {
        defaultValue: null,
        options: []
      }
    },
    loadedAtUnixMs: 1
  } as unknown as AgentActivityComposerOptions;

  it("switches the list by model without another catalog request", () => {
    expect(
      reasoningSelectionFromComposerOptions(
        composerOptions,
        "high",
        "gpt-5.6-sol"
      )
    ).toEqual({
      currentValue: "low",
      options: [
        { value: "low", label: "Low" },
        { value: "ultra", label: "ultra" }
      ]
    });
    expect(
      reasoningSelectionFromComposerOptions(
        composerOptions,
        "ultra",
        "gpt-5.6-luna"
      )
    ).toEqual({
      currentValue: "medium",
      options: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" }
      ]
    });
  });

  it("prefers the active ACP config options over the home catalog profile", () => {
    expect(
      reasoningSelectionFromComposerOptions(
        composerOptions,
        "xhigh",
        "gpt-5.6-sol",
        {
          configOptions: [
            {
              id: "reasoning_effort",
              currentValue: "xhigh",
              options: [
                { value: "high", name: "High" },
                { value: "xhigh", name: "X High" }
              ]
            }
          ]
        }
      )
    ).toEqual({
      currentValue: "xhigh",
      options: [
        { value: "high", label: "High" },
        { value: "xhigh", label: "X High" }
      ]
    });
  });

  it("preserves an authoritative empty model reasoning list", () => {
    expect(
      reasoningSelectionFromComposerOptions(
        composerOptions,
        "high",
        "no-reasoning"
      )
    ).toEqual({ currentValue: null, options: [] });
  });

  it("rejects a stale live current value outside the advertised list", () => {
    expect(
      reasoningSelectionFromComposerOptions(
        composerOptions,
        "ultra",
        "gpt-5.6-sol",
        {
          configOptions: [
            {
              id: "reasoning_effort",
              currentValue: "ultra",
              options: [
                { value: "high", name: "High" },
                { value: "xhigh", name: "X High" }
              ]
            }
          ]
        }
      )
    ).toEqual({
      currentValue: "high",
      options: [
        { value: "high", label: "High" },
        { value: "xhigh", label: "X High" }
      ]
    });
  });
});

describe("target-keyed composer defaults", () => {
  const baseNodeData: AgentGUINodeData = {
    provider: "codex",
    agentTargetId: "local:codex",
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

  it("reads target draft settings before provider legacy defaults", () => {
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
