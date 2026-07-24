package runtimeprep

import (
	"context"
	"strings"
	"testing"
)

type countingCommandCatalog struct {
	calls        int
	capabilities []CommandCapability
}

func (catalog *countingCommandCatalog) Capabilities(_ context.Context, _ CommandContext) []CommandCapability {
	catalog.calls++
	return append([]CommandCapability(nil), catalog.capabilities...)
}

func TestRenderSkillBundleDerivesSharedSkillsFromHostCommandCapabilities(t *testing.T) {
	catalog := &countingCommandCatalog{capabilities: tshStyleCommandCapabilities()}
	preparer := NewDefaultPreparer(t.TempDir())
	preparer.CLICommand = "tutti"
	preparer.CommandCatalog = catalog

	bundle, err := preparer.RenderSkillBundle(context.Background(), PrepareInput{
		WorkspaceID:    "room-1",
		AgentSessionID: "session-1",
		AgentTargetID:  "target-1",
		Provider:       "codex",
		BrowserUse:     true,
		ComputerUse:    true,
	})
	if err != nil {
		t.Fatalf("RenderSkillBundle() error = %v", err)
	}
	if catalog.calls != 1 {
		t.Fatalf("catalog calls = %d, want one resolved snapshot", catalog.calls)
	}

	tuttiSkill := bundleSkillContent(t, bundle, "tutti/tutti-cli")
	issueSkill := bundleSkillContent(t, bundle, "tutti/issue-manager")
	reference := bundleSkillContent(t, bundle, "tutti/reference")
	for _, content := range []string{tuttiSkill, issueSkill} {
		if strings.Contains(content, "issue task create-batch") {
			t.Fatalf("skill claims unavailable batch create: %q", content)
		}
		if strings.Contains(content, "--agent-target-id") {
			t.Fatalf("skill claims unavailable agent target input: %q", content)
		}
		if !strings.Contains(content, "--agent-provider codex") ||
			!strings.Contains(content, "--agent-session-id session-1") {
			t.Fatalf("skill missing schema-derived run identity: %q", content)
		}
		if strings.Contains(content, "--room-id") {
			t.Fatalf("agent-facing skill leaks protected workspace binding: %q", content)
		}
	}
	if !strings.Contains(issueSkill, "host has no batch-create capability") {
		t.Fatalf("issue skill missing ordered create fallback: %q", issueSkill)
	}
	if strings.Contains(tuttiSkill, "Browser automation uses `browser ...`") ||
		strings.Contains(tuttiSkill, "`computer ...` drives") {
		t.Fatalf("tutti skill claims unavailable automation family: %q", tuttiSkill)
	}
	if strings.Contains(reference, "`app`") || !strings.Contains(reference, "`task`") {
		t.Fatalf("reference sources were not capability-derived: %q", reference)
	}
	for _, id := range []string{"tutti/browser-use", "tutti/computer-use"} {
		if bundleHasSkill(bundle, id) {
			t.Fatalf("bundle injected unavailable skill %q", id)
		}
	}

	guide := bundleSkillFileContent(t, bundle, "tutti/tutti-cli", commandGuideReferencePath)
	if strings.Contains(guide, "--room-id") ||
		strings.Contains(guide, "browser navigate") ||
		strings.Contains(guide, "issue update --issue-id <issue-id> --status") {
		t.Fatalf("guide contains unavailable or host-bound inputs: %q", guide)
	}
	if !strings.Contains(guide, "issue update --issue-id <issue-id> --json") {
		t.Fatalf("guide missing schema-derived issue update: %q", guide)
	}
}

func TestResolvedCommandCapabilitiesKeepOutputExecutionAndFilterIntegration(t *testing.T) {
	catalog := &countingCommandCatalog{capabilities: []CommandCapability{
		{
			ID:          "public.empty-visibility",
			Path:        []string{"public", "show"},
			InputSchema: map[string]any{"properties": map[string]any{"room-id": map[string]any{"type": "string"}}, "required": []any{"room-id"}},
			Output: CommandCapabilityOutput{
				DefaultMode: "table",
				JSON:        true,
				Table:       &CommandTableOutput{Columns: []CommandTableColumn{{Key: "id", Label: "ID"}}},
			},
			ExecutionMode: "wait",
			Source:        CommandSource{Kind: CommandSourceApp, AppID: "public"},
		},
		{
			ID:         "browser.hidden",
			Path:       []string{"browser", "navigate"},
			Visibility: "integration",
			Source:     CommandSource{Kind: CommandSourceBuiltin},
		},
	}}
	resolved := resolveCommandCapabilities(context.Background(), catalog, "room-1")
	if len(resolved.commands) != 2 {
		t.Fatalf("resolved commands = %#v", resolved.commands)
	}
	public := resolved.commands[0]
	if public.Output.DefaultMode != "table" || !public.Output.JSON ||
		public.Output.Table == nil || len(public.Output.Table.Columns) != 1 {
		t.Fatalf("output metadata not retained: %#v", public.Output)
	}
	if public.ExecutionMode != "wait" || schemaHasInput(public.InputSchema, "room-id") ||
		!schemaHasInput(public.InputSchema, "timeout-ms") {
		t.Fatalf("agent projection = %#v", public)
	}
	guide := commandGuideFromCapabilities("tutti", resolved.commands)
	if !strings.Contains(guide, "tutti public show") || strings.Contains(guide, "browser navigate") {
		t.Fatalf("visibility filtering failed: %q", guide)
	}
}

func TestCommandGuideIncludesPublicReferenceAndComputerButNotIntegration(t *testing.T) {
	guide := commandGuideFromCapabilities("tutti", []CommandCapability{
		{ID: "references.task.list", Path: []string{"reference", "list"}, Summary: "List references"},
		{ID: "computer.screenshot", Path: []string{"computer", "screenshot"}, Summary: "Take screenshot"},
		{ID: "browser.navigate", Path: []string{"browser", "navigate"}, Summary: "Navigate", Visibility: "integration"},
	})
	if !strings.Contains(guide, "tutti reference list") ||
		!strings.Contains(guide, "tutti computer screenshot") {
		t.Fatalf("guide omitted public command families: %q", guide)
	}
	if strings.Contains(guide, "browser navigate") {
		t.Fatalf("guide included integration command: %q", guide)
	}
}

func tshStyleCommandCapabilities() []CommandCapability {
	command := func(id string, path []string, required []string, optional []string) CommandCapability {
		properties := make(map[string]any, len(required)+len(optional))
		for _, name := range append(append([]string(nil), required...), optional...) {
			properties[name] = map[string]any{"type": "string"}
		}
		return CommandCapability{
			ID:          id,
			Path:        path,
			Summary:     id,
			InputSchema: map[string]any{"type": "object", "properties": properties, "required": required},
			Source:      CommandSource{Kind: CommandSourceApp, AppID: "issue-manager"},
		}
	}
	commands := []CommandCapability{
		command("issue-manager.issue.get", []string{"issue", "get"}, []string{"room-id", "issue-id"}, nil),
		command("issue-manager.issue.update", []string{"issue", "update"}, []string{"room-id", "issue-id"}, []string{"title", "content"}),
		command("issue-manager.issue.task.create", []string{"issue", "task", "create"}, []string{"room-id", "issue-id", "title"}, []string{"content"}),
		command("issue-manager.issue.run.create", []string{"issue", "run", "create"}, []string{"room-id", "issue-id", "agent-provider"}, []string{"agent-session-id"}),
		command("issue-manager.issue.task.run.create", []string{"issue", "task", "run", "create"}, []string{"room-id", "issue-id", "task-id", "agent-provider"}, []string{"agent-session-id"}),
		command("issue-manager.issue.run.complete", []string{"issue", "run", "complete"}, []string{"room-id", "issue-id", "run-id", "status"}, []string{"summary", "outputs"}),
		command("issue-manager.issue.task.run.complete", []string{"issue", "task", "run", "complete"}, []string{"room-id", "issue-id", "task-id", "run-id", "status"}, []string{"summary", "outputs"}),
		command("issue-manager.issue.topic.list", []string{"issue", "topic", "list"}, []string{"room-id"}, nil),
		command("workspace-apps.app.open", []string{"app", "open"}, []string{"app-id"}, []string{"room-id"}),
		command("references.task.list", []string{"reference", "list"}, []string{"source", "id"}, []string{"room-id", "group-id"}),
		command("browser.navigate", []string{"browser", "navigate"}, []string{"url"}, nil),
	}
	commands[len(commands)-1].Visibility = "integration"
	commands[len(commands)-1].Source = CommandSource{Kind: CommandSourceBuiltin}
	return commands
}

func bundleSkillContent(t *testing.T, bundle SkillBundle, id string) string {
	t.Helper()
	for _, skill := range bundle.Skills {
		if skill.SkillID == id {
			return skill.Content
		}
	}
	t.Fatalf("skill %q not found", id)
	return ""
}

func bundleSkillFileContent(t *testing.T, bundle SkillBundle, id string, path string) string {
	t.Helper()
	for _, skill := range bundle.Skills {
		if skill.SkillID != id {
			continue
		}
		for _, file := range skill.Files {
			if file.Path == path {
				return file.Content
			}
		}
	}
	t.Fatalf("skill file %q/%q not found", id, path)
	return ""
}

func bundleHasSkill(bundle SkillBundle, id string) bool {
	for _, skill := range bundle.Skills {
		if skill.SkillID == id {
			return true
		}
	}
	return false
}
