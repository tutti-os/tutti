import { describe, expect, it } from "vitest";
import {
  patchBatchDirectoryCwd,
  resolvePatchExecutionCwd
} from "./agentTurnSummaryPatchRuntime";

describe("Agent Turn Summary patch cwd paths", () => {
  it("maps Git Bash drive paths to the Windows workspace drive", () => {
    const workspaceRoot = "C:\\Users\\demo\\project";
    const cwd = "/c/Users/demo/project";

    expect(
      patchBatchDirectoryCwd(
        `${cwd}/README.md`,
        [{ path: `${cwd}/README.md` }],
        workspaceRoot
      )
    ).toBe("C:/Users/demo/project");
    expect(resolvePatchExecutionCwd(cwd, workspaceRoot)).toBe(
      "C:/Users/demo/project"
    );
  });

  it("preserves POSIX /c paths when the workspace root is POSIX", () => {
    expect(
      resolvePatchExecutionCwd("/c/Users/demo/project", "/Users/demo/project")
    ).toBe("/c/Users/demo/project");
  });
});
