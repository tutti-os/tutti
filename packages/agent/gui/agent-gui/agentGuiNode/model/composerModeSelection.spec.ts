import { describe, expect, it } from "vitest";
import {
  permissionModeSelectionPatch,
  resolvePermissionModeControlsDisabled
} from "./composerModeSelection";

describe("permissionModeSelectionPatch", () => {
  it("clears plan mode for mutually-exclusive providers (claude-code)", () => {
    expect(
      permissionModeSelectionPatch("acceptEdits", { clearsPlanMode: true })
    ).toEqual({
      permissionModeId: "acceptEdits",
      planMode: false
    });
  });

  it("leaves plan mode intact for independent providers (codex)", () => {
    expect(
      permissionModeSelectionPatch("read-only", { clearsPlanMode: false })
    ).toEqual({
      permissionModeId: "read-only"
    });
  });
});

describe("resolvePermissionModeControlsDisabled", () => {
  it("stays enabled mid-turn for claude-code, since the SDK applies the change live", () => {
    expect(
      resolvePermissionModeControlsDisabled({
        provider: "claude-code",
        isSendingTurn: true,
        isSubmittingPrompt: false,
        showStopButton: true
      })
    ).toBe(false);
  });

  it("stays enabled mid-turn for codex, which re-derives the policy on the next turn/start regardless", () => {
    expect(
      resolvePermissionModeControlsDisabled({
        provider: "codex",
        isSendingTurn: true,
        isSubmittingPrompt: false,
        showStopButton: true
      })
    ).toBe(false);
  });

  it("still blocks claude-code/codex during the brief prompt-submission race", () => {
    expect(
      resolvePermissionModeControlsDisabled({
        provider: "claude-code",
        isSendingTurn: false,
        isSubmittingPrompt: true,
        showStopButton: false
      })
    ).toBe(true);
  });

  it("keeps the broader turn-in-flight gate for other ACP-backed providers", () => {
    expect(
      resolvePermissionModeControlsDisabled({
        provider: "nexight",
        isSendingTurn: false,
        isSubmittingPrompt: false,
        showStopButton: true
      })
    ).toBe(true);
  });

  it("leaves ACP-backed providers enabled once no turn is in flight", () => {
    expect(
      resolvePermissionModeControlsDisabled({
        provider: "gemini",
        isSendingTurn: false,
        isSubmittingPrompt: false,
        showStopButton: false
      })
    ).toBe(false);
  });
});
