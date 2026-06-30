import { afterEach, describe, expect, it } from "vitest";
import { setAgentGuiI18nTestLocale } from "../../../i18n/testUtils";
import type { AgentSessionPermissionConfig } from "../../../shared/agentSessionTypes";
import type { AgentGUIComposerSettingOption } from "../model/agentGuiNodeTypes";
import {
  advertisedConfigOptionValues,
  filterComposerSettingOptionsByAdvertised,
  permissionModeOptions
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

describe("advertisedConfigOptionValues", () => {
  it("returns null when runtime context is unknown", () => {
    expect(advertisedConfigOptionValues(null, "effort")).toBeNull();
    expect(advertisedConfigOptionValues(undefined, "effort")).toBeNull();
  });

  it("returns null when runtime context omits configOptions", () => {
    expect(advertisedConfigOptionValues({}, "effort")).toBeNull();
  });

  it("returns an empty set when configOptions is present but the option is not advertised", () => {
    // Mirrors Haiku: the agent advertises a model descriptor but no effort.
    const runtimeContext = {
      configOptions: [
        {
          id: "model",
          options: [{ value: "haiku" }, { value: "sonnet" }]
        }
      ]
    };
    const result = advertisedConfigOptionValues(runtimeContext, "effort");
    expect(result).not.toBeNull();
    expect(result?.size).toBe(0);
  });

  it("returns the advertised values when the option is present", () => {
    const runtimeContext = {
      configOptions: [
        {
          id: "effort",
          options: [{ value: "low" }, { value: "medium" }]
        }
      ]
    };
    expect(advertisedConfigOptionValues(runtimeContext, "effort")).toEqual(
      new Set(["low", "medium"])
    );
  });
});

describe("filterComposerSettingOptionsByAdvertised", () => {
  const options: AgentGUIComposerSettingOption[] = [
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" }
  ];

  it("shows every option when advertised values are unknown (null)", () => {
    expect(filterComposerSettingOptionsByAdvertised(options, null)).toEqual(
      options
    );
  });

  it("hides every option when nothing is advertised (empty set)", () => {
    expect(
      filterComposerSettingOptionsByAdvertised(options, new Set())
    ).toEqual([]);
  });

  it("keeps only advertised options", () => {
    expect(
      filterComposerSettingOptionsByAdvertised(
        options,
        new Set(["low", "medium"])
      )
    ).toEqual([
      { value: "low", label: "Low" },
      { value: "medium", label: "Medium" }
    ]);
  });
});
