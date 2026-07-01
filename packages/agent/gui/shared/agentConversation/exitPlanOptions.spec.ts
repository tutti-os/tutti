import { describe, expect, it } from "vitest";
import {
  extractExitPlanKeepPlanningOptionId,
  extractExitPlanModeOptions,
  isExitPlanSwitchModeInput
} from "./exitPlanOptions";

const switchModeInput = {
  requestId: "plan-request-1",
  toolCall: { kind: "switch_mode", title: "Exit plan mode" },
  options: [
    {
      optionId: "bypassPermissions",
      name: "Yes, and bypass permissions",
      kind: "bypassPermissions"
    },
    { optionId: "auto", name: "Yes, and use auto mode", kind: "auto" },
    {
      optionId: "acceptEdits",
      name: "Yes, and auto-accept edits",
      kind: "acceptEdits"
    },
    { optionId: "plan", name: "No, keep planning", kind: "plan" }
  ]
};

describe("isExitPlanSwitchModeInput", () => {
  it("matches a switch_mode tool call that offers a plan option", () => {
    expect(isExitPlanSwitchModeInput(switchModeInput)).toBe(true);
  });

  it("ignores switch_mode without a keep-planning option", () => {
    expect(
      isExitPlanSwitchModeInput({
        toolCall: { kind: "switch_mode" },
        options: [{ optionId: "acceptEdits" }]
      })
    ).toBe(false);
  });

  it("ignores non switch_mode tool calls", () => {
    expect(
      isExitPlanSwitchModeInput({
        toolCall: { kind: "exec_command" },
        options: [{ optionId: "plan" }]
      })
    ).toBe(false);
  });

  it("tolerates formatting differences in the tool-call kind", () => {
    expect(
      isExitPlanSwitchModeInput({
        toolCall: { kind: "switchMode" },
        options: [{ optionId: "plan" }]
      })
    ).toBe(true);
  });
});

describe("extractExitPlanModeOptions", () => {
  it("returns the mode options in runtime order, excluding keep-planning", () => {
    expect(extractExitPlanModeOptions(switchModeInput)).toEqual([
      {
        id: "bypassPermissions",
        label: "Yes, and bypass permissions",
        kind: "bypassPermissions"
      },
      { id: "auto", label: "Yes, and use auto mode", kind: "auto" },
      {
        id: "acceptEdits",
        label: "Yes, and auto-accept edits",
        kind: "acceptEdits"
      }
    ]);
  });

  it("preserves the runtime option id casing for submission", () => {
    expect(extractExitPlanModeOptions(switchModeInput)[0]?.id).toBe(
      "bypassPermissions"
    );
  });

  it("returns [] when no options are present", () => {
    expect(
      extractExitPlanModeOptions({ toolCall: { kind: "switch_mode" } })
    ).toEqual([]);
  });

  it("also reads options off the payload when provided", () => {
    expect(
      extractExitPlanModeOptions(
        {},
        { options: [{ optionId: "auto", name: "Auto" }] }
      )
    ).toEqual([{ id: "auto", label: "Auto", kind: "auto" }]);
  });
});

describe("extractExitPlanKeepPlanningOptionId", () => {
  it("returns the runtime keep-planning option id", () => {
    expect(extractExitPlanKeepPlanningOptionId(switchModeInput)).toBe("plan");
  });

  it("returns null when no keep-planning option exists", () => {
    expect(
      extractExitPlanKeepPlanningOptionId({
        toolCall: { kind: "switch_mode" },
        options: [{ optionId: "acceptEdits" }]
      })
    ).toBeNull();
  });
});
