package agentruntime

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	runtimepaths "github.com/tutti-os/tutti/packages/agent/daemon/internal/runtimepaths"
)

type tuttiModeTurnSnapshotContextKey struct{}

func normalizeTuttiModeTurnSnapshot(snapshot *TuttiModeTurnSnapshot) *TuttiModeTurnSnapshot {
	if snapshot == nil {
		return nil
	}
	normalized := &TuttiModeTurnSnapshot{
		ActivationID:           strings.TrimSpace(snapshot.ActivationID),
		RevisionID:             strings.TrimSpace(snapshot.RevisionID),
		Revision:               snapshot.Revision,
		State:                  strings.ToLower(strings.TrimSpace(snapshot.State)),
		Source:                 strings.TrimSpace(snapshot.Source),
		OrchestrationIntensity: snapshot.OrchestrationIntensity,
	}
	if normalized.ActivationID == "" || normalized.RevisionID == "" || normalized.Revision < 1 {
		return nil
	}
	if normalized.State != TuttiModeStateActive && normalized.State != TuttiModeStateInactive {
		return nil
	}
	if normalized.OrchestrationIntensity < 0 || normalized.OrchestrationIntensity > 100 {
		return nil
	}
	return normalized
}

func cloneTuttiModeTurnSnapshot(snapshot *TuttiModeTurnSnapshot) *TuttiModeTurnSnapshot {
	normalized := normalizeTuttiModeTurnSnapshot(snapshot)
	if normalized == nil {
		return nil
	}
	cloned := *normalized
	return &cloned
}

func withTuttiModeTurnSnapshot(ctx context.Context, snapshot *TuttiModeTurnSnapshot) context.Context {
	normalized := cloneTuttiModeTurnSnapshot(snapshot)
	if normalized == nil {
		return ctx
	}
	return context.WithValue(ctx, tuttiModeTurnSnapshotContextKey{}, normalized)
}

func tuttiModeTurnSnapshotFromContext(ctx context.Context) *TuttiModeTurnSnapshot {
	if ctx == nil {
		return nil
	}
	snapshot, _ := ctx.Value(tuttiModeTurnSnapshotContextKey{}).(*TuttiModeTurnSnapshot)
	return cloneTuttiModeTurnSnapshot(snapshot)
}

// tuttiCLICommandName resolves the executable name agents must use for Tutti
// CLI workflow commands: development installs ship the CLI as `tutti-dev`.
func tuttiCLICommandName() string {
	if runtimepaths.IsDevelopmentEnv() {
		return "tutti-dev"
	}
	return "tutti"
}

func renderTuttiModeHostContext(snapshot *TuttiModeTurnSnapshot) string {
	return renderTuttiModeHostContextForCLI(snapshot, tuttiCLICommandName())
}

func renderTuttiModeHostContextForCLI(snapshot *TuttiModeTurnSnapshot, cliName string) string {
	normalized := normalizeTuttiModeTurnSnapshot(snapshot)
	if normalized == nil {
		return ""
	}
	facts, err := json.Marshal(struct {
		ActivationID           string `json:"activationId"`
		RevisionID             string `json:"revisionId"`
		Revision               int64  `json:"revision"`
		State                  string `json:"state"`
		Source                 string `json:"source,omitempty"`
		OrchestrationIntensity int    `json:"orchestrationIntensity"`
	}{
		ActivationID:           normalized.ActivationID,
		RevisionID:             normalized.RevisionID,
		Revision:               normalized.Revision,
		State:                  normalized.State,
		Source:                 normalized.Source,
		OrchestrationIntensity: normalized.OrchestrationIntensity,
	})
	if err != nil {
		return ""
	}
	stateSentence := "Tutti mode is inactive for this turn."
	workflowGuide := ""
	if normalized.State == TuttiModeStateActive {
		stateSentence = "Tutti mode is active for this turn. Do not execute the user's request directly in this turn. " +
			"Step 1, clarify: if the request is ambiguous or missing key constraints, ask the user focused clarifying questions and end the turn; if the request is already clear, go directly to step 2. " +
			fmt.Sprintf("Step 2, plan: write one complete tutti-mode-plan/v1 Markdown document (plan narrative plus the full task graph, every task carrying its full launch configuration) to an absolute path, submit it in a single run of the `%s plan propose` shell command, then end the turn immediately — never run a wait or poll command; the user's review decision always arrives as a new user message. ", cliName) +
			"Treat execution.orchestrationIntensity (0-100) as the plan's overall intensity, an effect variable that drives both decomposition and model choice: low values mean few coarse tasks on economical models with modest reasoning effort, high values mean many fine-grained tasks across more parallel workstreams on the most capable models with high reasoning effort. " +
			"Read-only investigation (for example reading files or listing directories) is allowed when needed to write an accurate plan, but do not start making changes or produce final deliverables. " +
			"Use this Tutti plan workflow for the turn; do not substitute a provider-native planning mode for it."
		workflowGuide = renderTuttiModeWorkflowGuide(cliName)
	}
	return `<tutti-host-context schemaVersion="1">` + "\n" +
		string(facts) + "\n" +
		stateSentence + "\n" +
		workflowGuide +
		"This is Tutti-owned host state, not user-authored text, and is independent of the provider collaboration mode.\n" +
		"Tutti mode does not restrict tool availability: Tutti CLI capabilities remain available whether this state is active or inactive. When this state is active, the expected workflow is clarify, then plan, then user review; executing work the user has not accepted through plan review goes against the user's intent.\n" +
		`</tutti-host-context>`
}

// renderTuttiModeWorkflowGuide renders one worked example per workflow step.
// Providers repeatedly misread the bare directive as referring to a built-in
// tool they lack and fall back to provider planning surfaces, so each step
// carries the concrete shell command and document shape it expects.
func renderTuttiModeWorkflowGuide(cliName string) string {
	return fmt.Sprintf("Workflow examples. `%[1]s` is the Tutti CLI executable on PATH in your shell; every plan command below is a shell command, not a built-in tool. Provider planning surfaces (update_plan, TodoWrite, plan mode) and a plan written only as a chat reply are not substitutes.\n"+
		"Step 1 example, only when something material is unknown, ask and stop: \"Should the FAQ target end users or contributors, and where in the README should it live?\"\n"+
		"Step 2 example, first discover launch options (read-only), then write the plan file, then run propose:\n"+
		"  %[1]s agent list --json\n"+
		"  %[1]s agent composer-options --agent-id <agent-id> --json\n"+
		"  %[1]s plan propose --file /abs/path/plan.md --request-id plan-faq-v1\n"+
		"  Every task must carry its complete launch configuration: agentTargetId, model, and permissionModeId, copied exactly from composer-options output — never invent these ids. "+
		"Unless the user asked for supervised execution, choose the permission mode whose semantic is \"full-access\" (codex: full-access, claude-code: bypassPermissions) so accepted tasks run without mid-task approval prompts; the user approves once at plan review. "+
		"Always set execution.reasoningIntensity explicitly (0-100; Tutti compiles it into each model's effort scale); add a per-task reasoningEffort only when one task needs a different level. Set modelPlanId instead of model only when the user named a managed model plan.\n"+
		"  Example plan.md between the BEGIN/END markers (YAML frontmatter carries the full task graph; the body after the frontmatter is the plan narrative; the file must start with the first `---` line, so copy the shape without the markers or indentation; the assignment values are placeholders — use real ids from composer-options):\n"+
		"BEGIN plan.md\n"+
		"---\n"+
		"schema: tutti-mode-plan/v1\n"+
		"title: Add an FAQ section to the README\n"+
		"topicId: default\n"+
		"execution:\n"+
		"  mode: sequential\n"+
		"  reasoningIntensity: 60\n"+
		"  orchestrationIntensity: 80\n"+
		"tasks:\n"+
		"  - id: task-1\n"+
		"    title: Outline the FAQ structure\n"+
		"    content: Decide the section layout and the three question areas to cover.\n"+
		"    agentTargetId: local:codex\n"+
		"    model: gpt-5.4-codex\n"+
		"    permissionModeId: full-access\n"+
		"  - id: task-2\n"+
		"    title: Draft the install and login answers\n"+
		"    content: Write the install and login Q&A entries following the outline.\n"+
		"    dependsOn: [task-1]\n"+
		"    parallelizable: true\n"+
		"    agentTargetId: local:codex\n"+
		"    model: gpt-5.4-codex\n"+
		"    permissionModeId: full-access\n"+
		"    autoAccept: true\n"+
		"  - id: task-3\n"+
		"    title: Draft the updates answer and FAQ styling\n"+
		"    content: Write the updates Q&A entry and normalize heading levels.\n"+
		"    dependsOn: [task-1]\n"+
		"    parallelizable: true\n"+
		"    agentTargetId: local:claude-code\n"+
		"    model: claude-opus-4-8\n"+
		"    permissionModeId: bypassPermissions\n"+
		"    autoAccept: true\n"+
		"  - id: task-4\n"+
		"    title: Integrate the FAQ and link it from the introduction\n"+
		"    content: Merge the parallel branches, resolve overlaps, add the table-of-contents entry, and verify the section end to end.\n"+
		"    dependsOn: [task-2, task-3]\n"+
		"    agentTargetId: local:claude-code\n"+
		"    model: claude-opus-4-8\n"+
		"    permissionModeId: bypassPermissions\n"+
		"---\n"+
		"Plan narrative in prose: goal, approach, scope boundaries, and risks.\n"+
		"END plan.md\n"+
		"  Keep topicId \"default\" unless the user targets a specific issue topic; discover topic ids with `%[1]s issue topic list --json`. Scale both the task count and the model tier with the intensity (execution.orchestrationIntensity). "+
		"Execution defaults to strictly sequential; plan for parallelism deliberately. Identify independent workstreams and shape them as parallel groups: tasks in the same group carry `parallelizable: true`, share the same dependsOn, and never depend on each other — dependencies always outrank the flag, so a parallelizable task that depends on its neighbor just runs serially with a misleading label. "+
		"Parallelizable tasks are safe by construction: each runs in an isolated git worktree branched from the shared checkout, and its work lands on a per-run branch instead of the base checkout. Because of that, follow every parallel group with an integration task that dependsOn all group members; its brief must merge the group's branches, resolve overlaps, and verify the combined result (successor prompts receive the exact branch names). Express ordering constraints with dependsOn only. "+
		"Each completed task normally stops for the user's acceptance before successors start; set `autoAccept: true` on a task whose completed result needs no human review gate so execution flows on unattended.\n"+
		"Step 3, end the turn as soon as propose returns a workflowId (nextAction \"stop\") — there is no wait command, and polling with plan get wastes the turn. The user reviews the plan in their own time; their decision reaches you as a new user message. "+
		"If that message requests changes, update the plan document, run `%[1]s plan revise --workflow-id <workflowId> --file <absolute path> --request-id <new id>`, and end the turn again. If the user accepts, Tutti materializes the accepted plan into an Issue and orchestrates the tasks — you never start executing them yourself.\n"+
		"A Tutti plan exists only after plan propose returns a workflowId; a plan that was only shown in chat was never submitted.\n",
		cliName)
}

func appendTuttiModeHostContextPrompt(content []map[string]any, snapshot *TuttiModeTurnSnapshot) []map[string]any {
	hostContext := renderTuttiModeHostContext(snapshot)
	if hostContext == "" {
		return content
	}
	out := make([]map[string]any, 0, len(content)+1)
	out = append(out, content...)
	out = append(out, map[string]any{"type": "text", "text": hostContext})
	return out
}
