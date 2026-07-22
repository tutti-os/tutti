package tuttimodeplan

import "testing"

// Probe: the exact plan.md example embedded in the tutti mode host context
// few-shot guide (packages/agent/daemon/runtime/tutti_mode_host_context.go)
// must parse as a valid single-review proposal document, including the
// per-task launch configuration the guide requires.
func TestHostContextExamplePlanDocumentParses(t *testing.T) {
	example := "---\n" +
		"schema: tutti-mode-plan/v1\n" +
		"title: Add an FAQ section to the README\n" +
		"topicId: default\n" +
		"execution:\n" +
		"  mode: sequential\n" +
		"  reasoningIntensity: 60\n" +
		"  orchestrationIntensity: 80\n" +
		"tasks:\n" +
		"  - id: task-1\n" +
		"    title: Outline the FAQ structure\n" +
		"    content: Decide the section layout and the three question areas to cover.\n" +
		"    agentTargetId: local:codex\n" +
		"    model: gpt-5.4-codex\n" +
		"    permissionModeId: full-access\n" +
		"  - id: task-2\n" +
		"    title: Draft the install and login answers\n" +
		"    content: Write the install and login Q&A entries following the outline.\n" +
		"    dependsOn: [task-1]\n" +
		"    parallelizable: true\n" +
		"    agentTargetId: local:codex\n" +
		"    model: gpt-5.4-codex\n" +
		"    permissionModeId: full-access\n" +
		"    autoAccept: true\n" +
		"  - id: task-3\n" +
		"    title: Draft the updates answer and FAQ styling\n" +
		"    content: Write the updates Q&A entry and normalize heading levels.\n" +
		"    dependsOn: [task-1]\n" +
		"    parallelizable: true\n" +
		"    agentTargetId: local:claude-code\n" +
		"    model: claude-opus-4-8\n" +
		"    permissionModeId: bypassPermissions\n" +
		"    autoAccept: true\n" +
		"  - id: task-4\n" +
		"    title: Integrate the FAQ and link it from the introduction\n" +
		"    content: Merge the parallel branches, resolve overlaps, add the table-of-contents entry, and verify the section end to end.\n" +
		"    dependsOn: [task-2, task-3]\n" +
		"    agentTargetId: local:claude-code\n" +
		"    model: claude-opus-4-8\n" +
		"    permissionModeId: bypassPermissions\n" +
		"---\n" +
		"Plan narrative in prose: goal, approach, scope boundaries, and risks.\n"
	document, err := ParsePlanMarkdown([]byte(example))
	if err != nil {
		t.Fatalf("ParsePlanMarkdown() error = %v", err)
	}
	if document.Phase != PhaseTaskGraph {
		t.Fatalf("phase = %q, want task_graph", document.Phase)
	}
	if document.Execution.Mode != "sequential" ||
		document.Execution.ReasoningIntensity != 60 ||
		document.Execution.OrchestrationIntensity != 80 {
		t.Fatalf("execution = %#v", document.Execution)
	}
	if len(document.Tasks) != 4 {
		t.Fatalf("tasks = %#v", document.Tasks)
	}
	outline, draftA, draftB, integrate := document.Tasks[0], document.Tasks[1], document.Tasks[2], document.Tasks[3]
	if outline.AgentTargetID != "local:codex" || outline.Model != "gpt-5.4-codex" || outline.PermissionModeID != "full-access" {
		t.Fatalf("task-1 launch configuration = %#v", outline)
	}
	// The example must demonstrate a real parallel group: two tasks that share
	// the same dependency, never depend on each other, and both carry the flag.
	if outline.Parallelizable || !draftA.Parallelizable || !draftB.Parallelizable || integrate.Parallelizable {
		t.Fatalf("parallelizable flags = %v/%v/%v/%v", outline.Parallelizable, draftA.Parallelizable, draftB.Parallelizable, integrate.Parallelizable)
	}
	if draftA.DependsOn[0] != "task-1" || draftB.DependsOn[0] != "task-1" {
		t.Fatalf("parallel group dependencies = %#v/%#v, want shared task-1", draftA.DependsOn, draftB.DependsOn)
	}
	if len(integrate.DependsOn) != 2 || integrate.DependsOn[0] != "task-2" || integrate.DependsOn[1] != "task-3" {
		t.Fatalf("integration dependencies = %#v, want [task-2 task-3]", integrate.DependsOn)
	}
	if outline.AutoAccept || !draftA.AutoAccept || !draftB.AutoAccept || integrate.AutoAccept {
		t.Fatalf("autoAccept flags = %v/%v/%v/%v", outline.AutoAccept, draftA.AutoAccept, draftB.AutoAccept, integrate.AutoAccept)
	}
	if integrate.AgentTargetID != "local:claude-code" || integrate.Model != "claude-opus-4-8" || integrate.PermissionModeID != "bypassPermissions" {
		t.Fatalf("task-4 launch configuration = %#v", integrate)
	}
}
