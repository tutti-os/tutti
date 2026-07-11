import { afterEach, describe, expect, it } from "vitest";
import { setAgentGuiI18nTestLocale } from "../../../i18n/testUtils";
import type { AgentSessionPermissionConfig } from "../../../shared/agentSessionTypes";
import type { AgentGUINodeData } from "../../../types";
import {
  buildNodeDefaultComposerSettings,
  slashCommandPoliciesEqual,
  composerOptionsMissingLiveModelValues,
  liveModelOptionValuesFromRuntimeContext,
  mergeRuntimeContextComposerSettings,
  nodeDataFromComposerSettings,
  permissionModeOptions,
  providerSkillsFromComposerOptions,
  readNodeDefaultDraftPrompt,
  readNodeDefaultDraftSettings
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

describe("live model options from runtime context", () => {
  const cursorRuntimeContext = {
    configOptions: [
      { id: "mode", options: [{ value: "agent", name: "Agent" }] },
      {
        id: "model",
        currentValue: "composer-2.5[fast=true]",
        options: [
          { value: "default[]", name: "Auto" },
          { value: "composer-2.5[fast=true]", name: "composer-2.5" },
          { value: "gpt-5.2[reasoning=medium,fast=false]", name: "gpt-5.2" }
        ]
      }
    ]
  };

  it("extracts advertised model values", () => {
    expect(
      liveModelOptionValuesFromRuntimeContext(cursorRuntimeContext)
    ).toEqual([
      "default[]",
      "composer-2.5[fast=true]",
      "gpt-5.2[reasoning=medium,fast=false]"
    ]);
    expect(liveModelOptionValuesFromRuntimeContext(null)).toEqual([]);
    expect(liveModelOptionValuesFromRuntimeContext({})).toEqual([]);
    expect(
      liveModelOptionValuesFromRuntimeContext({ configOptions: "nope" })
    ).toEqual([]);
  });

  it("detects composer options missing live models and quiesces once merged", () => {
    const staleOptions = {
      provider: "cursor",
      models: [
        { value: "composer-2.5[fast=true]", label: "composer-2.5[fast=true]" }
      ],
      reasoningEfforts: [],
      speeds: [],
      skills: [],
      loadedAtUnixMs: 1
    } as unknown as AgentActivityComposerOptions;
    const mergedOptions = {
      ...staleOptions,
      models: [
        { value: "default[]", label: "Auto" },
        { value: "composer-2.5[fast=true]", label: "composer-2.5" },
        { value: "gpt-5.2[reasoning=medium,fast=false]", label: "gpt-5.2" }
      ]
    } as unknown as AgentActivityComposerOptions;
    const liveValues =
      liveModelOptionValuesFromRuntimeContext(cursorRuntimeContext);

    expect(
      composerOptionsMissingLiveModelValues(staleOptions, liveValues)
    ).toBe(true);
    expect(
      composerOptionsMissingLiveModelValues(mergedOptions, liveValues)
    ).toBe(false);
    expect(composerOptionsMissingLiveModelValues(null, liveValues)).toBe(false);
    expect(composerOptionsMissingLiveModelValues(staleOptions, [])).toBe(false);
  });
});

describe("descriptor-backed runtime config options", () => {
  it("updates Codex config keys from daemon-provided descriptors without provider branches", () => {
    const runtimeContext = {
      config: {},
      configOptions: [
        { id: "model", currentValue: "gpt-5" },
        { id: "reasoning_effort", currentValue: "medium" },
        { id: "service_tier", currentValue: "standard" },
        { id: "mode", currentValue: "auto" }
      ]
    };

    expect(
      mergeRuntimeContextComposerSettings(runtimeContext, {
        model: "gpt-5.3-codex",
        reasoningEffort: "high",
        speed: "fast",
        permissionModeId: "full-access"
      })
    ).toEqual({
      config: {
        model: "gpt-5.3-codex",
        reasoning_effort: "high",
        service_tier: "fast",
        mode: "full-access"
      },
      configOptions: [
        { id: "model", currentValue: "gpt-5.3-codex" },
        { id: "reasoning_effort", currentValue: "high" },
        { id: "service_tier", currentValue: "fast" },
        { id: "mode", currentValue: "full-access" }
      ]
    });
  });

  it("does not invent provider config keys when descriptors are unavailable", () => {
    const runtimeContext = { config: { providerOwned: true } };

    expect(
      mergeRuntimeContextComposerSettings(runtimeContext, {
        model: "model",
        reasoningEffort: "high",
        speed: "fast",
        permissionModeId: "auto"
      })
    ).toEqual(runtimeContext);
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
