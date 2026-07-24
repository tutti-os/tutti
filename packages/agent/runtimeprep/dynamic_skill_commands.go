package runtimeprep

import (
	"fmt"
	"sort"
	"strings"
)

func commandCapability(input PrepareInput, ids ...string) (CommandCapability, bool) {
	resolved := input.commandCapabilities
	if resolved == nil || !resolved.hostProvided {
		return CommandCapability{}, false
	}
	for _, id := range ids {
		for _, capability := range resolved.commands {
			if commandVisibleToAgent(capability) && strings.TrimSpace(capability.ID) == id {
				return capability, true
			}
		}
	}
	return CommandCapability{}, false
}

func commandFamilyAvailable(input PrepareInput, family string) bool {
	resolved := input.commandCapabilities
	if resolved == nil || !resolved.hostProvided {
		return true
	}
	for _, capability := range resolved.commands {
		if commandVisibleToAgent(capability) && len(capability.Path) > 0 && strings.TrimSpace(capability.Path[0]) == family {
			return true
		}
	}
	return false
}

func capabilityInvocation(input PrepareInput, capability CommandCapability, values map[string]string, optional ...string) string {
	command := normalizeCLICommandName(input.CLICommand) + " " + commandPath(capability.Path)
	required := stringSliceSchemaValue(capability.InputSchema["required"])
	sort.Strings(required)
	for _, name := range required {
		value := firstNonEmptyText(values[name], "<"+name+">")
		command += " --" + name + " " + shellExampleValue(value)
	}
	for _, name := range optional {
		if !schemaHasInput(capability.InputSchema, name) {
			continue
		}
		value := firstNonEmptyText(values[name], "<"+name+">")
		command += " --" + name + " " + shellExampleValue(value)
	}
	return command + " --json"
}

func shellExampleValue(value string) string {
	if strings.ContainsAny(value, " \t") && !strings.HasPrefix(value, "'") && !strings.HasPrefix(value, "\"") {
		return "\"" + value + "\""
	}
	return value
}

func dynamicRouteFirstGuidance(input PrepareInput) string {
	lines := []string{agentRouteFirstGuidance(input)}
	index := 4
	if commandFamilyAvailable(input, "browser") {
		lines = append(lines, fmt.Sprintf("%d. Browser automation uses `browser ...`.", index))
		index++
	}
	if commandFamilyAvailable(input, "computer") {
		lines = append(lines, fmt.Sprintf("%d. macOS desktop automation uses `computer ...`.", index))
		index++
	}
	lines = append(lines, fmt.Sprintf("%d. If none match, read `command-guide.md` before guessing.", index))
	return strings.Join(lines, "\n")
}

func dynamicFamilyReference(input PrepareInput) string {
	lines := []string{
		"`issue ...` covers the issue operations advertised in the current command guide. Workflow sequencing belongs to `$issue-manager`, not this skill.",
		"",
		"`agent ...` covers the agent operations advertised in the current command guide. Discover exact agent ids and supported flags from that guide/current help; provider-specific start shortcuts must not be assumed.",
	}
	if commandFamilyAvailable(input, "browser") {
		lines = append(lines, "", "`browser ...` drives the host-advertised browser session. Prefer it when Tutti browser context is requested.")
	}
	if commandFamilyAvailable(input, "computer") {
		lines = append(lines, "", "`computer ...` drives the host-advertised desktop session. Prefer it when Tutti computer context is requested.")
	}
	lines = append(lines, "", "Workspace app scopes are discovered from command guide or capability metadata that preserves `App id:`. Use `$workspace-app` for app mention interpretation and command selection; `$workspace-app` is a skill and mention kind, not a CLI scope. Use CLI help only after the scope is known.")
	return strings.Join(lines, "\n")
}

func appOpenGuidance(input PrepareInput) string {
	capability, ok := commandCapability(input, "workspace-apps.app.open")
	if input.commandCapabilities == nil || !input.commandCapabilities.hostProvided {
		return strings.ReplaceAll(defaultAppOpenGuidance, "{{CLI_COMMAND}}", normalizeCLICommandName(input.CLICommand))
	}
	if !ok {
		return "The current host does not advertise an app-window open command. Do not guess one; use app-specific CLI capabilities for app work."
	}
	invocation := capabilityInvocation(input, capability, map[string]string{"app-id": "<app-id>"})
	return "- `" + invocation + "` is allowed only when the user explicitly asks to open or show an app window, or confirms one should be opened.\n- Do not use an open command as the default way to inspect, query, update, or execute app work. Prefer the app-specific CLI capability for the requested operation."
}

func issueAppOpenGuidance(input PrepareInput) string {
	if capability, ok := commandCapability(input, "workspace-apps.app.open"); ok {
		command := capabilityInvocation(input, capability, map[string]string{"app-id": "issue-manager"})
		return "If the user explicitly asks to open or show the Task Manager app window, use `" + command + "`. Do not use app opening for issue work."
	}
	if input.commandCapabilities != nil && input.commandCapabilities.hostProvided {
		return "The current host advertises no Task Manager app-window command. Do not guess one; issue work uses the advertised issue capabilities."
	}
	return "If the user explicitly asks to open or show the Task Manager app window, use `app open --app-id issue-manager --json`. Do not use app opening as a substitute for issue work."
}

func commandOutputGuidance(input PrepareInput) string {
	if input.commandCapabilities == nil || !input.commandCapabilities.hostProvided {
		return strings.Join([]string{
			"- `--json` means machine-readable output, not every domain field.",
			"- List JSON is compact; use get/detail commands for fuller records.",
			"- Browser and computer commands usually return plain text.",
			"- Save ids returned by create/start/run-create commands and reuse them.",
		}, "\n")
	}
	modes := make(map[string]struct{})
	for _, capability := range input.commandCapabilities.commands {
		if !commandVisibleToAgent(capability) {
			continue
		}
		if mode := strings.TrimSpace(capability.Output.DefaultMode); mode != "" {
			modes[mode] = struct{}{}
		}
	}
	lines := []string{
		"- Follow each capability's advertised default output mode and JSON support; use current help when output metadata is absent.",
		"- Save ids returned by create/start/run-create commands and reuse them.",
	}
	if len(modes) > 0 {
		values := make([]string, 0, len(modes))
		for mode := range modes {
			values = append(values, mode)
		}
		sort.Strings(values)
		lines = append(lines, "- Advertised default modes in this snapshot: `"+strings.Join(values, "`, `")+"`.")
	}
	return strings.Join(lines, "\n")
}

const defaultAppOpenGuidance = `- ` + "`{{CLI_COMMAND}} app open --app-id <app-id> --json`" + ` is allowed only when the user explicitly asks to open or show an app window, or confirms an app window should be opened.
- Do not use ` + "`app open`" + ` or app-specific open commands as the default way to inspect, query, update, or execute app work. Prefer the app-specific CLI command for the requested operation.`

func issueGetInvocation(input PrepareInput) string {
	if capability, ok := commandCapability(input, "issue-manager.issue.get"); ok {
		return capabilityInvocation(input, capability, map[string]string{"issue-id": "<issue-id>", "room-id": "<room-id>"})
	}
	if input.commandCapabilities != nil && input.commandCapabilities.hostProvided {
		return ""
	}
	return normalizeCLICommandName(input.CLICommand) + " issue get --issue-id <issue-id> --json"
}

func issueRunCreateInvocation(input PrepareInput, task bool) string {
	id := "issue-manager.issue.run.create"
	fallbackPath := "issue run create"
	values := map[string]string{
		"issue-id":         "<issue-id>",
		"room-id":          "<room-id>",
		"agent-target-id":  strings.TrimSpace(input.AgentTargetID),
		"agent-provider":   strings.TrimSpace(input.Provider),
		"agent-session-id": strings.TrimSpace(input.AgentSessionID),
	}
	if task {
		id = "issue-manager.issue.task.run.create"
		fallbackPath = "issue task run create"
		values["task-id"] = "<task-id>"
	}
	if capability, ok := commandCapability(input, id); ok {
		return capabilityInvocation(input, capability, values, "agent-session-id")
	}
	if input.commandCapabilities != nil && input.commandCapabilities.hostProvided {
		return ""
	}
	command := normalizeCLICommandName(input.CLICommand) + " " + fallbackPath + " --issue-id <issue-id>"
	if task {
		command += " --task-id <task-id>"
	}
	return command + " --agent-target-id " + strings.TrimSpace(input.AgentTargetID) + " --json"
}

func issueRunCompleteInvocation(input PrepareInput, task bool) string {
	id := "issue-manager.issue.run.complete"
	fallbackPath := "issue run complete"
	values := map[string]string{
		"issue-id": "<issue-id>", "task-id": "<task-id>", "run-id": "<run-id>",
		"room-id": "<room-id>", "status": "completed", "summary": "<summary>",
		"outputs": "'[{\"path\":\"<artifact-path>\"}]'",
	}
	if task {
		id = "issue-manager.issue.task.run.complete"
		fallbackPath = "issue task run complete"
	}
	if capability, ok := commandCapability(input, id); ok {
		return capabilityInvocation(input, capability, values, "summary", "outputs")
	}
	if input.commandCapabilities != nil && input.commandCapabilities.hostProvided {
		return ""
	}
	command := normalizeCLICommandName(input.CLICommand) + " " + fallbackPath + " --issue-id <issue-id>"
	if task {
		command += " --task-id <task-id>"
	}
	return command + " --run-id <run-id> --status completed --summary \"<summary>\" --outputs '[{\"path\":\"<artifact-path>\"}]' --json"
}

func issueRunMetadataGuidance(input PrepareInput) string {
	if input.commandCapabilities == nil || !input.commandCapabilities.hostProvided {
		return "Run metadata: use `--agent-target-id " + strings.TrimSpace(input.AgentTargetID) + "`. The daemon derives the provider from that target; do not use `--agent-provider` for new runs. Do not pass `--agent-session-id` in normal AgentGUI execution; the CLI binds the current AgentGUI session from the runtime context."
	}
	issueCommand := issueRunCreateInvocation(input, false)
	taskCommand := issueRunCreateInvocation(input, true)
	if issueCommand == "" && taskCommand == "" {
		return "The current host does not advertise issue-run creation. Inspection and breakdown remain available, but do not invent run commands."
	}
	lines := []string{"Run creation syntax is host-derived; identity and session flags come from each command's advertised input schema."}
	if issueCommand != "" {
		lines = append(lines, "- Issue run: `"+issueCommand+"`")
	}
	if taskCommand != "" {
		lines = append(lines, "- Task run: `"+taskCommand+"`")
	}
	return strings.Join(lines, "\n")
}

func issueRunOpenGuidance(input PrepareInput) string {
	if input.commandCapabilities == nil || !input.commandCapabilities.hostProvided {
		return "- Handoff includes `taskId` → `" + issueRunCreateInvocation(input, true) + "`\n- Handoff omits `taskId` → inspect issue tasks before creating a run:\n  - no child tasks → `" + issueRunCreateInvocation(input, false) + "`\n  - child tasks present → execute each child task in issue order: one task run create → work → task run complete per task before the next"
	}
	taskCommand := issueRunCreateInvocation(input, true)
	issueCommand := issueRunCreateInvocation(input, false)
	lines := make([]string, 0, 2)
	if taskCommand != "" {
		lines = append(lines, "- Handoff includes `taskId` → `"+taskCommand+"`")
	}
	if issueCommand != "" {
		lines = append(lines, "- Handoff omits `taskId` → inspect issue tasks; with no child tasks use `"+issueCommand+"`; with child tasks execute them in order using the task-run command above.")
	}
	if len(lines) == 0 {
		return "- Run creation is unavailable in the current host capability catalog. Do not enter execution mode by guessing a command."
	}
	return strings.Join(lines, "\n")
}

func issueRunCompleteGuidance(input PrepareInput) string {
	taskCommand := issueRunCompleteInvocation(input, true)
	issueCommand := issueRunCompleteInvocation(input, false)
	lines := make([]string, 0, 2)
	if taskCommand != "" {
		lines = append(lines, "- Scoped task run → `"+taskCommand+"` when artifacts exist")
	}
	if issueCommand != "" {
		lines = append(lines, "- Issue-level run → `"+issueCommand+"` when artifacts exist")
	}
	if len(lines) == 0 {
		return "- Run completion is unavailable in the current host capability catalog."
	}
	return strings.Join(lines, "\n")
}

func issueBreakdownPersistenceGuidance(input PrepareInput) string {
	if capability, ok := commandCapability(input, "issue-manager.issue.task.create-batch"); ok {
		command := capabilityInvocation(input, capability, map[string]string{
			"issue-id": "<issue-id>", "room-id": "<room-id>",
			"tasks-json": "'[{\"title\":\"<title>\",\"content\":\"<content>\"}]'",
		})
		return "**Persist by default.** Write multiple new tasks with `" + command + "`, one new task with the advertised `issue task create`, or update existing tasks with the advertised `issue task update`."
	}
	if capability, ok := commandCapability(input, "issue-manager.issue.task.create"); ok {
		command := capabilityInvocation(input, capability, map[string]string{
			"issue-id": "<issue-id>", "room-id": "<room-id>", "title": "<title>", "content": "<content>",
		}, "content")
		return "**Persist by default.** The host has no batch-create capability. Create multiple child tasks by calling `" + command + "` once per task in issue order; use the advertised task-update command for existing tasks."
	}
	if input.commandCapabilities != nil && input.commandCapabilities.hostProvided {
		return "**Persistence is unavailable.** The current host advertises no child-task create capability; return a draft and state that it could not be saved."
	}
	return "**Persist by default.** Write multiple new tasks back with `issue task create-batch`, one new task with `issue task create`, or existing tasks with `issue task update` in the same turn."
}

func issueReferenceGuidance(input PrepareInput) string {
	if input.commandCapabilities == nil || !input.commandCapabilities.hostProvided {
		return "`issue get` and `issue task get` return `detail.references`; read relevant returned paths directly and do not re-resolve them."
	}
	return "Inspect only fields actually returned by the host. The command capability schema describes inputs, not guaranteed output fields; do not assume `detail.references` unless it is present in the response."
}

func issueExtraReadGuidance(input PrepareInput) string {
	if input.commandCapabilities == nil || !input.commandCapabilities.hostProvided {
		return strings.Join([]string{
			"- `taskId`: `issue task get --issue-id <issue-id> --task-id <task-id> --json`",
			"- `runId` with `taskId`: `issue task run get --issue-id <issue-id> --task-id <task-id> --run-id <run-id> --json`",
			"- `runId` without `taskId`: `issue run get --issue-id <issue-id> --run-id <run-id> --json`",
			"- `topicId`: matching topic from `issue topic list --json`",
		}, "\n")
	}
	specs := []struct {
		label  string
		id     string
		values map[string]string
	}{
		{"`taskId`", "issue-manager.issue.task.get", map[string]string{"issue-id": "<issue-id>", "task-id": "<task-id>"}},
		{"`runId` with `taskId`", "issue-manager.issue.task.run.get", map[string]string{"issue-id": "<issue-id>", "task-id": "<task-id>", "run-id": "<run-id>"}},
		{"`runId` without `taskId`", "issue-manager.issue.run.get", map[string]string{"issue-id": "<issue-id>", "run-id": "<run-id>"}},
		{"`topicId`", "issue-manager.issue.topic.list", map[string]string{}},
	}
	lines := make([]string, 0, len(specs))
	for _, spec := range specs {
		if capability, ok := commandCapability(input, spec.id); ok {
			lines = append(lines, "- "+spec.label+": `"+capabilityInvocation(input, capability, spec.values)+"`")
		}
	}
	if len(lines) == 0 {
		return "- No additional issue read commands are advertised. Do not guess one."
	}
	return strings.Join(lines, "\n")
}

func referenceCapability(input PrepareInput) (CommandCapability, bool) {
	if capability, ok := commandCapability(input, "references.task.list", "references.reference.list", "reference.list"); ok {
		return capability, true
	}
	if input.commandCapabilities != nil && input.commandCapabilities.hostProvided {
		for _, capability := range input.commandCapabilities.commands {
			if commandVisibleToAgent(capability) && commandPath(capability.Path) == "reference list" {
				return capability, true
			}
		}
	}
	return CommandCapability{}, false
}

func referenceSources(input PrepareInput) []string {
	if capability, ok := referenceCapability(input); ok {
		property := mapSchemaValue(mapSchemaValue(capability.InputSchema["properties"])["source"])
		if values := stringSliceSchemaValue(property["enum"]); len(values) > 0 {
			return values
		}
		if strings.Contains(strings.TrimSpace(capability.ID), ".task.") {
			return []string{"task"}
		}
		return nil
	}
	if input.commandCapabilities == nil || !input.commandCapabilities.hostProvided {
		return []string{"app", "task"}
	}
	return nil
}

func referenceMentionContract(input PrepareInput) string {
	sources := referenceSources(input)
	if len(sources) == 0 {
		if _, ok := referenceCapability(input); !ok {
			return "The current host does not advertise reference resolution. Parse the URI as data, but do not guess a `reference` command."
		}
		return "Use only a `source` value accepted by the current command schema/help. The capability does not advertise a closed enum, so do not invent source kinds."
	}
	return "- URL path: the referenced entity id.\n- `source`: one of `" + strings.Join(sources, "`, `") + "` as advertised by the host.\n- `workspaceId`: required scope.\n- `groupId`: optional sub-scope when supported by the command schema."
}

func referenceResolveGuidance(input PrepareInput) string {
	if capability, ok := referenceCapability(input); ok {
		command := capabilityInvocation(input, capability, map[string]string{
			"source": "<source>", "id": "<id>", "room-id": "<room-id>", "group-id": "<groupId>",
		}, "group-id")
		return "Run exactly one host-advertised command to list the referenced files:\n\n`" + command + "`"
	}
	if input.commandCapabilities != nil && input.commandCapabilities.hostProvided {
		return "Reference resolution is unavailable in the current host capability catalog. Do not guess a command."
	}
	return "Run exactly one command to list the referenced files:\n\n`" + normalizeCLICommandName(input.CLICommand) + " reference list --source <source> --id <id> [--group-id <groupId>] --json`"
}

func policyIssueFallback(input PrepareInput) string {
	if command := issueGetInvocation(input); command != "" {
		return "parse id/query, start with `" + command + "`."
	}
	return "parse id/query and use `$issue-manager`; the current host advertises no issue-get fallback command."
}

func policyReferenceFallback(input PrepareInput) string {
	if capability, ok := referenceCapability(input); ok {
		return "`" + capabilityInvocation(input, capability, map[string]string{
			"source": "<source>", "id": "<id>", "room-id": "<room-id>", "group-id": "<groupId>",
		}, "group-id") + "`, then read returned paths."
	}
	if input.commandCapabilities == nil || !input.commandCapabilities.hostProvided {
		return "`" + normalizeCLICommandName(input.CLICommand) + " reference list --source <source> --id <id> [--group-id <groupId>] --json`, then read returned paths."
	}
	return "use `$reference`; the current host advertises no reference-list fallback command."
}

func policyAppOpenLine(input PrepareInput) string {
	if capability, ok := commandCapability(input, "workspace-apps.app.open"); ok {
		return "- Open app only on explicit open/show: `" + capabilityInvocation(input, capability, map[string]string{"app-id": "<appId>", "room-id": "<room-id>"}) + "`. Do not invent a `workspace-app` scope."
	}
	if input.commandCapabilities != nil && input.commandCapabilities.hostProvided {
		return "- The current host advertises no app-window open command. Do not guess one."
	}
	return "- Open app only on explicit open/show: `" + normalizeCLICommandName(input.CLICommand) + " app open --app-id <appId> --json`. Do not invent `" + normalizeCLICommandName(input.CLICommand) + " workspace-app ...`."
}
