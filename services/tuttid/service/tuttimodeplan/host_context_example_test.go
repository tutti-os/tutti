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
		"    title: Draft the FAQ section\n" +
		"    content: Write three Q&A entries covering install, login, and updates.\n" +
		"    agentTargetId: local:codex\n" +
		"    model: gpt-5.4-codex\n" +
		"    permissionModeId: full-access\n" +
		"    parallelizable: true\n" +
		"  - id: task-2\n" +
		"    title: Link the FAQ from the introduction\n" +
		"    content: Add a table-of-contents entry pointing at the new section.\n" +
		"    dependsOn: [task-1]\n" +
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
	if len(document.Tasks) != 2 || document.Tasks[1].DependsOn[0] != "task-1" {
		t.Fatalf("tasks = %#v", document.Tasks)
	}
	first, second := document.Tasks[0], document.Tasks[1]
	if first.AgentTargetID != "local:codex" || first.Model != "gpt-5.4-codex" || first.PermissionModeID != "full-access" {
		t.Fatalf("task-1 launch configuration = %#v", first)
	}
	if !first.Parallelizable || second.Parallelizable {
		t.Fatalf("parallelizable flags = %v/%v, want true/false", first.Parallelizable, second.Parallelizable)
	}
	if second.AgentTargetID != "local:claude-code" || second.Model != "claude-opus-4-8" || second.PermissionModeID != "bypassPermissions" {
		t.Fatalf("task-2 launch configuration = %#v", second)
	}
}
