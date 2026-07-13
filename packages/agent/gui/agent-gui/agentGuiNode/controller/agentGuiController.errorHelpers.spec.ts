import { describe, expect, it } from "vitest";
import {
  AGENT_CONFIG_DEPENDENCY_UNAVAILABLE_REASON,
  getAgentGUIConfigDependencyErrorDetails
} from "./agentGuiController.errorHelpers";

describe("agentGuiController.errorHelpers", () => {
  it("extracts only safe config dependency diagnostics", () => {
    expect(
      getAgentGUIConfigDependencyErrorDetails({
        code: "workspace_operation_failed",
        reason: AGENT_CONFIG_DEPENDENCY_UNAVAILABLE_REASON,
        params: {
          provider: " codex ",
          configKey: "model_instructions_file",
          dependencyPath: "profiles/instructions.md",
          failureKind: "missing",
          sourcePath: "/Users/example/.codex/profiles/instructions.md"
        }
      })
    ).toEqual({
      provider: "codex",
      configKey: "model_instructions_file",
      dependencyPath: "profiles/instructions.md",
      failureKind: "missing"
    });
  });

  it("ignores unrelated protocol errors", () => {
    expect(
      getAgentGUIConfigDependencyErrorDetails({
        reason: "workspace_operation_failed"
      })
    ).toBeNull();
  });
});
