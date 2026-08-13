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
	effect := snapshot.Effect
	speed := snapshot.Speed
	if snapshot.PreferenceVersion < TuttiModePreferenceVersionEffectSpeed {
		effect = snapshot.OrchestrationIntensity
		speed = 50
	}
	normalized := &TuttiModeTurnSnapshot{
		ActivationID:           strings.TrimSpace(snapshot.ActivationID),
		RevisionID:             strings.TrimSpace(snapshot.RevisionID),
		Revision:               snapshot.Revision,
		State:                  strings.ToLower(strings.TrimSpace(snapshot.State)),
		Source:                 strings.TrimSpace(snapshot.Source),
		PreferenceVersion:      TuttiModePreferenceVersionEffectSpeed,
		Effect:                 effect,
		Speed:                  speed,
		OrchestrationIntensity: effect,
	}
	if normalized.ActivationID == "" || normalized.RevisionID == "" || normalized.Revision < 1 {
		return nil
	}
	if normalized.State != TuttiModeStateActive && normalized.State != TuttiModeStateInactive {
		return nil
	}
	if normalized.Effect < 0 || normalized.Effect > 100 ||
		normalized.Speed < 0 || normalized.Speed > 100 {
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

func tuttiModeParallelTarget(speed int) int {
	normalized := min(100, max(0, speed))
	return min(4, normalized/25+1)
}

func renderTuttiModeHostContextForCLI(snapshot *TuttiModeTurnSnapshot, cliName string) string {
	normalized := normalizeTuttiModeTurnSnapshot(snapshot)
	if normalized == nil {
		return ""
	}
	facts, err := json.Marshal(struct {
		ActivationID   string `json:"activationId"`
		RevisionID     string `json:"revisionId"`
		Revision       int64  `json:"revision"`
		State          string `json:"state"`
		Source         string `json:"source,omitempty"`
		Effect         int    `json:"effect"`
		Speed          int    `json:"speed"`
		ParallelTarget int    `json:"parallelTarget"`
		// Deprecated compatibility alias for older provider instructions.
		OrchestrationIntensity int `json:"orchestrationIntensity"`
	}{
		ActivationID:           normalized.ActivationID,
		RevisionID:             normalized.RevisionID,
		Revision:               normalized.Revision,
		State:                  normalized.State,
		Source:                 normalized.Source,
		Effect:                 normalized.Effect,
		Speed:                  normalized.Speed,
		ParallelTarget:         tuttiModeParallelTarget(normalized.Speed),
		OrchestrationIntensity: normalized.Effect,
	})
	if err != nil {
		return ""
	}
	activationRule := "The JSON `state` field is authoritative for whether Tutti Mode is active for this turn. " +
		"Determine and report Tutti Mode status only from that field. " +
		"Provider collaboration mode and Tutti workflow existence are independent facts and must not override the activation state. " +
		"Tutti Mode activation is controlled by the user; never try to change it with Tutti CLI or other tools. "
	stateSentence := "Tutti mode is inactive for this turn. " + activationRule
	workflowGuide := ""
	if normalized.State == TuttiModeStateActive {
		stateSentence = "Tutti mode is active for this turn. " + activationRule +
			"Do not execute the user's request directly in this turn. " +
			"Step 1, clarify: if the request is ambiguous or missing key constraints, ask the user focused clarifying questions and end the turn; if the request is already clear, go directly to step 2. " +
			fmt.Sprintf("When the user requests a plan and the request is clear, follow step 2 and submit it through `%s plan propose`; a chat-only plan is not a proposal. ", cliName) +
			fmt.Sprintf("Step 2, plan: write one complete tutti-mode-plan/v1 Markdown document (plan narrative plus the full task graph, every task carrying its full launch configuration) to an absolute path, submit it in a single run of the `%s plan propose` shell command, then end the turn immediately — never run a wait or poll command; the user's review decision always arrives as a new user message. ", cliName) +
			"Treat effect and speed as independent 0-100 preferences. Effect drives outcome quality: higher values require stronger suitable models and stronger task verification. Speed drives completion latency: higher values favor faster suitable models and raise the parallel Agent target carried in parallelTarget. Combine them rather than averaging them: first satisfy the requested effect, then choose the fastest suitable option; never satisfy speed by selecting a model that cannot meet the requested effect. " +
			"Use the injected `$tutti-model-allocation` skill as the assignment policy: classify every task on its C0-C3 capability ladder, combine the task tier with the effect floor, use speed to rank models that clear that floor, and shape independent work toward parallelTarget. " +
			"Copy effect and speed into the optional execution.effect and execution.speed preference snapshots. Keep the existing execution.reasoningIntensity and execution.orchestrationIntensity meanings unchanged: reasoningIntensity is the Issue/provider reasoning strength, while orchestrationIntensity is decomposition, dependency, review, and retry strength and must never represent speed. For every task, state concrete validation expectations scaled by effect: low means one focused check, balanced means relevant tests plus integration checks when applicable, and high means broad relevant tests, edge/variant coverage, and an explicit final review. Do not invent tasks merely to fill parallelTarget; actual concurrency is limited by real dependency and ownership boundaries, safe isolation, budget, ready work, and workspace capacity. " +
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
		"Apply `$tutti-model-allocation` to those current catalogs before choosing each model; its model table is a tiering prior, never an availability source. "+
		"Unless the user asked for supervised execution, choose the permission mode whose semantic is \"full-access\" (codex: full-access, claude-code: bypassPermissions) so accepted tasks run without mid-task approval prompts; the user approves once at plan review. "+
		"Always copy the host preferences into execution.effect and execution.speed. Set execution.reasoningIntensity for the plan's actual provider reasoning strength (the effect value is the default), and keep execution.orchestrationIntensity for actual decomposition, dependency, review, and retry strength; never put speed in that field. Add a per-task reasoningEffort only when one task needs a different level. Set modelPlanId instead of model only when the user named a managed model plan. "+
		"Use the host parallelTarget as the upper target for concurrently schedulable independent tasks. Keep execution.mode \"sequential\" and mark independent tasks with parallelizable: true so the orchestrator may explicitly schedule them together; execution.mode \"parallel\" is rejected at propose unless every task sets its own unique absolute executionDirectory.\n"+
		"  Example plan.md between the BEGIN/END markers (YAML frontmatter carries the full task graph; the body after the frontmatter is the plan narrative; the file must start with the first `---` line, so copy the shape without the markers or indentation; the assignment values are placeholders — use real ids from composer-options):\n"+
		"BEGIN plan.md\n"+
		"---\n"+
		"schema: tutti-mode-plan/v1\n"+
		"title: Add an FAQ section to the README\n"+
		"topicId: default\n"+
		"execution:\n"+
		"  mode: sequential\n"+
		"  effect: 80\n"+
		"  speed: 60\n"+
		"  reasoningIntensity: 80\n"+
		"  orchestrationIntensity: 50\n"+
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
		"  - id: task-3\n"+
		"    title: Draft the updates answer and FAQ styling\n"+
		"    content: Write the updates Q&A entry and normalize heading levels.\n"+
		"    dependsOn: [task-1]\n"+
		"    parallelizable: true\n"+
		"    agentTargetId: local:claude-code\n"+
		"    model: claude-opus-4-8\n"+
		"    permissionModeId: bypassPermissions\n"+
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
		"  Keep topicId \"default\" unless the user targets a specific issue topic; discover topic ids with `%[1]s issue topic list --json`. Select each task's model by combining execution.effect and execution.speed, and encode effect-scaled verification in each task brief. "+
		"Execution defaults to strictly sequential; plan for parallelism deliberately. Identify independent workstreams and shape them as parallel groups toward parallelTarget: tasks in the same group carry `parallelizable: true`, share the same dependsOn, and never depend on each other — dependencies always outrank the target and flag, so a parallelizable task that depends on its neighbor just runs serially with a misleading label. "+
		"Parallelizable tasks are safe by construction: each runs in an isolated git worktree branched from the shared checkout, and its work lands on a per-run branch instead of the base checkout. Worktree isolation requires the shared checkout to be a git repository — when the plan starts from a fresh or non-git directory, the first task must initialize one (`git init` plus an initial commit) or every task must carry its own unique absolute execution directory. At schedule time an unsafe concurrent set is rejected; schedule those tasks one at a time instead. Because of that, follow every parallel group with an integration task that dependsOn all group members; its brief must merge the group's branches, resolve overlaps, and verify the combined result (successor prompts receive the exact branch names). Express ordering constraints with dependsOn only. "+
		"`autoAccept` is retained only for compatibility and has no dispatch authority for a Tutti-owned Issue. No task starts automatically after plan acceptance or after another task settles.\n"+
		"Step 3, end the turn as soon as propose returns a workflowId (nextAction \"stop\") — there is no wait command, and polling with plan get wastes the turn. The user reviews the plan in their own time; their decision reaches you as a new user message. "+
		"If that message requests changes, update the plan document, run `%[1]s plan revise --workflow-id <workflowId> --file <absolute path> --request-id <new id>`, and end the turn again. If the user accepts, Tutti materializes an inert Issue plus an initial execution checkpoint, and this conversation becomes the plan's orchestrator. Inspect the checkpoint and board state, choose no more than parallelTarget exact ready task IDs to run, then invoke `%[1]s plan issue schedule --issue-id <issueId> --checkpoint-id <checkpointId> --expected-graph-revision <revision> --task-ids-json '[\"task-1\"]' --request-id <stable-id>`; the command must schedule exactly the task IDs you selected. After every task settles this conversation is woken again to review evidence and explicitly decide the next graph command; it never executes the child tasks' work itself. The user can steer you with messages at any time, and stopping this conversation stops every running task. A dispatch-paused Issue must stay quiet; when the user explicitly asks to continue, the original source conversation can run `%[1]s plan issue resume --issue-id <issueId> --json` before using the unchanged active checkpoint. When all tasks becoming terminal starts Goal Review, review whether the user's goal is actually satisfied and never infer completion from task counts. Add and schedule more work when needed; otherwise finish only with `%[1]s plan issue complete --issue-id <issueId> --checkpoint-id <checkpointId> --expected-graph-revision <revision> --decision goal_satisfied --request-id <stable-id>`. An independent reviewer verdict is advisory evidence; a negative or inconclusive verdict requires an audited disagreement reason before completion.\n"+
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
