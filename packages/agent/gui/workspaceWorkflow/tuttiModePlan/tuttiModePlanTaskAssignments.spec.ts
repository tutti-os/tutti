import { describe, expect, it } from "vitest";
import {
  effectiveTaskAssignmentValue,
  mergeTaskAssignmentDraft,
  taskAssignmentInputsFromDrafts
} from "./tuttiModePlanTaskAssignments";
import type { TuttiModePlanPanelTaskViewModel } from "./tuttiModePlanPanelProjection";

function taskViewModel(
  overrides: Partial<TuttiModePlanPanelTaskViewModel> & { id: string }
): TuttiModePlanPanelTaskViewModel {
  return {
    ordinal: 1,
    title: "Task",
    content: "",
    priority: "medium",
    agentTargetId: null,
    modelPlanId: null,
    model: null,
    permissionModeId: null,
    reasoningEffort: null,
    executionDirectory: null,
    dependsOn: [],
    ...overrides
  };
}

describe("mergeTaskAssignmentDraft", () => {
  it("stores field edits per task", () => {
    const drafts = mergeTaskAssignmentDraft({}, "task-1", {
      reasoningEffort: "high"
    });
    expect(drafts["task-1"]).toEqual({ reasoningEffort: "high" });
  });

  it("resets dependent selections when the agent changes", () => {
    let drafts = mergeTaskAssignmentDraft({}, "task-1", {
      modelPlanId: "plan-1",
      model: "model-1"
    });
    drafts = mergeTaskAssignmentDraft(drafts, "task-1", {
      agentTargetId: "agent-2"
    });
    expect(drafts["task-1"]).toEqual({
      agentTargetId: "agent-2",
      modelPlanId: "",
      model: "",
      permissionModeId: "",
      reasoningEffort: ""
    });
  });

  it("keeps other fields when the same agent is re-selected", () => {
    let drafts = mergeTaskAssignmentDraft({}, "task-1", {
      agentTargetId: "agent-1"
    });
    drafts = mergeTaskAssignmentDraft(drafts, "task-1", { model: "model-9" });
    drafts = mergeTaskAssignmentDraft(drafts, "task-1", {
      agentTargetId: "agent-1"
    });
    expect(drafts["task-1"]?.model).toBe("model-9");
  });
});

describe("effectiveTaskAssignmentValue", () => {
  it("prefers the draft edit, including an explicit clear", () => {
    expect(effectiveTaskAssignmentValue(undefined, "doc-value")).toBe(
      "doc-value"
    );
    expect(effectiveTaskAssignmentValue("edit", "doc-value")).toBe("edit");
    expect(effectiveTaskAssignmentValue("", "doc-value")).toBe("");
    expect(effectiveTaskAssignmentValue(undefined, null)).toBe("");
  });
});

describe("taskAssignmentInputsFromDrafts", () => {
  it("sends only touched tasks and touched fields", () => {
    const tasks = [
      taskViewModel({ id: "task-1" }),
      taskViewModel({ id: "task-2", ordinal: 2 })
    ];
    const drafts = mergeTaskAssignmentDraft({}, "task-2", {
      reasoningEffort: "high"
    });
    const inputs = taskAssignmentInputsFromDrafts(drafts, tasks);
    expect(inputs).toEqual([{ taskId: "task-2", reasoningEffort: "high" }]);
    expect("model" in inputs[0]!).toBe(false);
  });

  it("carries the dependent clears produced by an agent change", () => {
    const tasks = [taskViewModel({ id: "task-1" })];
    const drafts = mergeTaskAssignmentDraft({}, "task-1", {
      agentTargetId: "agent-1"
    });
    expect(taskAssignmentInputsFromDrafts(drafts, tasks)).toEqual([
      {
        taskId: "task-1",
        agentTargetId: "agent-1",
        modelPlanId: "",
        model: "",
        permissionModeId: "",
        reasoningEffort: ""
      }
    ]);
  });

  it("drops drafts for tasks missing from the current revision", () => {
    const drafts = mergeTaskAssignmentDraft({}, "task-gone", {
      model: "model-1"
    });
    expect(
      taskAssignmentInputsFromDrafts(drafts, [taskViewModel({ id: "task-1" })])
    ).toEqual([]);
  });

  it("returns an empty payload for untouched drafts", () => {
    expect(
      taskAssignmentInputsFromDrafts({}, [taskViewModel({ id: "task-1" })])
    ).toEqual([]);
  });
});
