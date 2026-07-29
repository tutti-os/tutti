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

func TestRenderSkillBundleUsesOneHostCommandSnapshot(t *testing.T) {
	capabilities := testCommandCapabilities()
	filtered := make([]CommandCapability, 0, len(capabilities))
	for _, capability := range capabilities {
		if capability.ID == "issue-manager.issue.task.create-batch" ||
			strings.HasPrefix(capability.ID, "computer.") {
			continue
		}
		if strings.HasPrefix(capability.ID, "browser.") {
			capability.Visibility = "integration"
		}
		filtered = append(filtered, capability)
	}
	catalog := &countingCommandCatalog{capabilities: filtered}
	preparer := NewDefaultPreparer(t.TempDir())
	preparer.CommandCatalog = catalog
	preparer.CLICommand = "tutti-dev"

	bundle, err := preparer.RenderSkillBundle(t.Context(), PrepareInput{
		WorkspaceID:    "workspace-1",
		AgentSessionID: "session-1",
		AgentTargetID:  "local:codex",
		Provider:       "codex",
		BrowserUse:     true,
		ComputerUse:    true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if catalog.calls != 1 {
		t.Fatalf("catalog calls = %d, want 1", catalog.calls)
	}

	issue := bundleSkillContent(t, bundle, "tutti/issue-manager")
	if !strings.Contains(issue, "Host has no usable batch-create capability") ||
		!strings.Contains(issue, "tutti-dev issue task create") {
		t.Fatalf("issue skill did not select the advertised single-create flow: %s", issue)
	}
	for _, forbidden := range []string{
		"issue task create-batch",
		"--room-id",
	} {
		if strings.Contains(issue, forbidden) {
			t.Fatalf("issue skill leaked unsupported syntax %q: %s", forbidden, issue)
		}
	}
	for _, id := range []string{"tutti/browser-use", "tutti/computer-use"} {
		if bundleHasSkill(bundle, id) {
			t.Fatalf("bundle materialized unavailable skill %q", id)
		}
	}

	guide := bundleSkillFileContent(t, bundle, "tutti/tutti-cli", commandGuideReferencePath)
	if strings.Contains(guide, "browser navigate") ||
		strings.Contains(guide, "computer screenshot") ||
		strings.Contains(guide, "--room-id") {
		t.Fatalf("guide leaked commands outside the agent-facing snapshot: %s", guide)
	}
	if !strings.Contains(guide, "tutti-dev issue update --issue-id <issue-id> --json") {
		t.Fatalf("guide missing advertised command: %s", guide)
	}
}

func TestRuntimeTemplateFailsOnUnknownCommandOrInput(t *testing.T) {
	resolver, err := newCommandResolver("tutti", []CommandCapability{{
		ID:          "known",
		Path:        []string{"known"},
		InputSchema: map[string]any{"properties": map[string]any{"value": map[string]any{"type": "string"}}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	input := PrepareInput{commandCapabilities: resolver}
	for name, template := range map[string]string{
		"unknown command": `{{command "missing"}}`,
		"unknown input":   `{{command "known" (args "missing" "value")}}`,
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := renderRuntimeTemplate(name, template, input, nil); err == nil {
				t.Fatal("renderRuntimeTemplate() error = nil")
			}
		})
	}
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
