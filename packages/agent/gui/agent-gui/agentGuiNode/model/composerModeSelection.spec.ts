import { describe, expect, it } from "vitest";
import {
  permissionModeSelectionPatch,
  resolvePermissionModeControlsDisabled,
  shouldRetrySessionSettingsUpdate
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
  it("stays enabled mid-turn when the provider applies permission changes live", () => {
    expect(
      resolvePermissionModeControlsDisabled({
        changeDuringTurnSupported: true,
        isSendingTurn: true,
        isSubmittingPrompt: false,
        showStopButton: true
      })
    ).toBe(false);
  });

  it("still blocks claude-code/codex during the brief prompt-submission race", () => {
    expect(
      resolvePermissionModeControlsDisabled({
        changeDuringTurnSupported: true,
        isSendingTurn: false,
        isSubmittingPrompt: true,
        showStopButton: false
      })
    ).toBe(true);
  });

  it("keeps the broader turn-in-flight gate for other ACP-backed providers", () => {
    expect(
      resolvePermissionModeControlsDisabled({
        changeDuringTurnSupported: false,
        isSendingTurn: false,
        isSubmittingPrompt: false,
        showStopButton: true
      })
    ).toBe(true);
  });

  it("leaves ACP-backed providers enabled once no turn is in flight", () => {
    expect(
      resolvePermissionModeControlsDisabled({
        changeDuringTurnSupported: false,
        isSendingTurn: false,
        isSubmittingPrompt: false,
        showStopButton: false
      })
    ).toBe(false);
  });
});

describe("shouldRetrySessionSettingsUpdate", () => {
  it("treats a new user selection as an explicit retry after an unknown result", () => {
    expect(shouldRetrySessionSettingsUpdate("unknown")).toBe(true);
  });

  it.each([null, "idle", "inFlight", "failed"])(
    "does not mark %s as an uncertain retry",
    (status) => {
      expect(shouldRetrySessionSettingsUpdate(status)).toBe(false);
    }
  );
});
