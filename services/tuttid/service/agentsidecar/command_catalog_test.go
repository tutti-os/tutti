package agentsidecar

import (
	"context"
	"strings"
	"testing"

	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
)

func TestCommandGuideFromCapabilitiesUsesRelevantRegistryCommands(t *testing.T) {
	guide := commandGuideFromCapabilities("tutti", []cliservice.Capability{
		{
			ID:          "diagnostics.ping",
			Path:        []string{"diagnostics", "ping"},
			Summary:     "Ping",
			Description: "Ignored.",
		},
		{
			ID:          "issue-manager.issue.topic.list",
			Path:        []string{"issue", "topic", "list"},
			Summary:     "List issue topics",
			Description: "List workspace issue topics.",
		},
		{
			ID:          "issue-manager.issue.list",
			Path:        []string{"issue", "list"},
			Summary:     "List issues",
			Description: "List issue records in a specific workspace topic.",
			InputSchema: map[string]any{"required": []any{"topic-id"}},
		},
		{
			ID:          "issue-manager.issue.get",
			Path:        []string{"issue", "get"},
			Summary:     "Get issue detail",
			Description: "Get an issue detail record and its tasks.",
			InputSchema: map[string]any{"required": []any{"issue-id"}},
		},
		{
			ID:          "issue-manager.issue.update",
			Path:        []string{"issue", "update"},
			Summary:     "Update an issue",
			Description: "Update issue title, content, or status.",
			InputSchema: map[string]any{"required": []any{"issue-id"}},
		},
		{
			ID:          "issue-manager.issue.task.update",
			Path:        []string{"issue", "task", "update"},
			Summary:     "Update an issue task",
			Description: "Update a task under an issue.",
			InputSchema: map[string]any{"required": []any{"issue-id", "task-id"}},
		},
		{
			ID:          "issue-manager.issue.task.create",
			Path:        []string{"issue", "task", "create"},
			Summary:     "Create an issue task",
			Description: "Create or persist a breakdown child task without creating a run.",
			InputSchema: map[string]any{"required": []any{"issue-id", "title"}},
		},
		{
			ID:          "issue-manager.issue.task.run.complete",
			Path:        []string{"issue", "task", "run", "complete"},
			Summary:     "Complete an issue task run",
			Description: "Complete a task run.",
			InputSchema: map[string]any{"required": []any{"issue-id", "task-id", "run-id", "status"}},
		},
		{
			ID:          "issue-manager.issue.task.run.create",
			Path:        []string{"issue", "task", "run", "create"},
			Summary:     "Create an issue task run",
			Description: "Create a task run.",
			InputSchema: map[string]any{"required": []any{"issue-id", "task-id", "agent-provider", "agent-session-id"}},
		},
		{
			ID:          "agent-context.agent.sessions",
			Path:        []string{"agent", "sessions"},
			Summary:     "List agent sessions",
			Description: "List agent sessions.",
		},
		{
			ID:          "workspace-apps.app.open",
			Path:        []string{"app", "open"},
			Summary:     "Open a workspace app",
			Description: "Launch or activate an installed workspace app.",
			InputSchema: map[string]any{"required": []any{"app-id"}},
		},
		{
			ID:          "ai-media-canvas.aimc.open",
			Path:        []string{"aimc", "open"},
			Summary:     "Open AI Canvas",
			Description: "Open AI Canvas.",
			Source: cliservice.CapabilitySource{
				Kind:    cliservice.CapabilitySourceApp,
				AppID:   "ai-media-canvas",
				AppName: "AI Canvas",
			},
		},
		{
			ID:          "app.tutti-onboarding.onboarding.read",
			Path:        []string{"onboarding", "read"},
			Summary:     "Read onboarding",
			Description: "Read onboarding guide.",
			Source: cliservice.CapabilitySource{
				Kind:    cliservice.CapabilitySourceApp,
				AppID:   "tutti-onboarding",
				AppName: "新手指引",
			},
		},
		{
			ID:          "agent-context.agent.tutti-cli-skill-bundle",
			Path:        []string{"agent", "tutti-cli-skill-bundle"},
			Summary:     "Get Tutti CLI skill bundle",
			Description: "Get a host integration skill bundle.",
		},
	})

	if !strings.Contains(guide, "tutti issue get --issue-id <issue-id>") {
		t.Fatalf("guide missing issue get: %q", guide)
	}
	if !strings.Contains(guide, "tutti issue topic list") {
		t.Fatalf("guide missing topic list: %q", guide)
	}
	if !strings.Contains(guide, "tutti issue list --topic-id <topic-id>") {
		t.Fatalf("guide missing topic-scoped issue list: %q", guide)
	}
	if !strings.Contains(guide, "tutti issue update --issue-id <issue-id> --status completed --json") {
		t.Fatalf("guide missing issue update: %q", guide)
	}
	if !strings.Contains(guide, "tutti issue task update --issue-id <issue-id> --task-id <task-id> --status completed --json") {
		t.Fatalf("guide missing issue task update: %q", guide)
	}
	if !strings.Contains(guide, "tutti issue task create --issue-id <issue-id> --title <title>") ||
		!strings.Contains(guide, "without creating a run") {
		t.Fatalf("guide missing breakdown task create guidance: %q", guide)
	}
	if !strings.Contains(guide, "tutti issue task run create --agent-provider <agent-provider> --agent-session-id <agent-session-id> --issue-id <issue-id> --task-id <task-id> --json") {
		t.Fatalf("guide missing issue task run create: %q", guide)
	}
	if !strings.Contains(guide, "tutti issue task run complete --issue-id <issue-id> --run-id <run-id> --status <status> --task-id <task-id> --summary <summary>") {
		t.Fatalf("guide missing issue task run complete: %q", guide)
	}
	if !strings.Contains(guide, "tutti agent sessions") {
		t.Fatalf("guide missing agent sessions: %q", guide)
	}
	if !strings.Contains(guide, "tutti app open --app-id <app-id> --json") ||
		!strings.Contains(guide, "Use only when the user explicitly asks to open or show an app window") {
		t.Fatalf("guide missing guarded app open: %q", guide)
	}
	// Generic app commands are no longer inlined as command lines; they appear in
	// the compact app index and are fetched on demand via `app commands`.
	if strings.Contains(guide, "tutti aimc open") {
		t.Fatalf("guide should not inline app command lines: %q", guide)
	}
	if strings.Contains(guide, "tutti onboarding read") {
		t.Fatalf("guide should not inline app command lines: %q", guide)
	}
	if !strings.Contains(guide, "tutti app commands --app-id <app id> --json") {
		t.Fatalf("guide missing app index lookup instruction: %q", guide)
	}
	if !strings.Contains(guide, "AI Canvas") || !strings.Contains(guide, "(app id: ai-media-canvas)") {
		t.Fatalf("guide missing AI Canvas app index entry: %q", guide)
	}
	if !strings.Contains(guide, "新手指引") || !strings.Contains(guide, "(app id: tutti-onboarding)") {
		t.Fatalf("guide missing onboarding app index entry: %q", guide)
	}
	if strings.Contains(guide, "skill-bundle") {
		t.Fatalf("guide included host integration command: %q", guide)
	}
	if strings.Contains(guide, "diagnostics") {
		t.Fatalf("guide included irrelevant command: %q", guide)
	}
}

func TestCommandGuideRendersCompactAppIndex(t *testing.T) {
	guide := commandGuideFromCapabilities("tutti", []cliservice.Capability{
		{
			ID:      "issue-manager.issue.list",
			Path:    []string{"issue", "list"},
			Summary: "List issues",
		},
		{
			ID:   "ai-media-canvas.aimc.open",
			Path: []string{"aimc", "open"},
			Source: cliservice.CapabilitySource{
				Kind:           cliservice.CapabilitySourceApp,
				AppID:          "ai-media-canvas",
				AppName:        "AI Canvas",
				AppDescription: "Generative media\ncanvas   for agents.",
			},
		},
		{
			ID:   "ai-media-canvas.aimc.export",
			Path: []string{"aimc", "export"},
			Source: cliservice.CapabilitySource{
				Kind:    cliservice.CapabilitySourceApp,
				AppID:   "ai-media-canvas",
				AppName: "AI Canvas",
			},
		},
		{
			ID:   "ai-doc.doc.read",
			Path: []string{"doc", "read"},
			Source: cliservice.CapabilitySource{
				Kind:    cliservice.CapabilitySourceApp,
				AppID:   "ai-doc",
				AppName: "AI Doc",
			},
		},
		{
			// Agent launchers stay inline lines and must NOT appear in the index.
			ID:   "agent-context.codex.start",
			Path: []string{"codex", "start"},
			Source: cliservice.CapabilitySource{
				Kind:    cliservice.CapabilitySourceApp,
				AppID:   "agent-codex",
				AppName: "Codex",
			},
		},
	})

	// One deduped entry per app id, sorted (ai-doc before ai-media-canvas).
	docIdx := strings.Index(guide, "(app id: ai-doc)")
	canvasIdx := strings.Index(guide, "(app id: ai-media-canvas)")
	if docIdx < 0 || canvasIdx < 0 {
		t.Fatalf("guide missing app index entries: %q", guide)
	}
	if docIdx > canvasIdx {
		t.Fatalf("app index not sorted by id: %q", guide)
	}
	if strings.Count(guide, "(app id: ai-media-canvas)") != 1 {
		t.Fatalf("app index not deduped: %q", guide)
	}
	// One-line description collapses internal whitespace/newlines.
	if !strings.Contains(guide, "Generative media canvas for agents.") {
		t.Fatalf("app description not collapsed to one line: %q", guide)
	}
	// Launcher excluded from index but still rendered as a command line.
	if strings.Contains(guide, "(app id: agent-codex)") {
		t.Fatalf("agent launcher should not appear in app index: %q", guide)
	}
	if !strings.Contains(guide, "tutti codex start") {
		t.Fatalf("agent launcher should still render as a command line: %q", guide)
	}
}

func TestCommandGuideFromCatalogPassesAgentRuntimeContext(t *testing.T) {
	catalog := fakeCommandCatalog{}
	guide := commandGuideFromCatalog(context.Background(), &catalog, "workspace-1", "tutti")
	if catalog.context.Source != "agent-runtime" || catalog.context.WorkspaceID != "workspace-1" {
		t.Fatalf("context = %#v", catalog.context)
	}
	if !strings.Contains(guide, "tutti issue list") {
		t.Fatalf("guide = %q", guide)
	}
}

func TestCommandGuideFromCatalogUsesProvidedCLIName(t *testing.T) {
	catalog := fakeCommandCatalog{}

	guide := commandGuideFromCatalog(context.Background(), &catalog, "workspace-1", "tutti-dev")

	if !strings.Contains(guide, "tutti-dev issue list") {
		t.Fatalf("guide = %q, want tutti-dev command", guide)
	}
	if strings.Contains(guide, "`tutti issue list`") {
		t.Fatalf("guide = %q, should not use production command in development", guide)
	}
}

func TestCommandGuideFromCapabilitiesIncludesProviderAgentApps(t *testing.T) {
	guide := commandGuideFromCapabilities("tutti-dev", []cliservice.Capability{
		{
			ID:          "agent-context.codex.start",
			Path:        []string{"codex", "start"},
			Summary:     "Start a Codex agent session",
			Description: "Start a Codex agent session in the current workspace.",
			InputSchema: map[string]any{"required": []string{"model", "prompt"}},
			Source: cliservice.CapabilitySource{
				Kind:    cliservice.CapabilitySourceApp,
				AppID:   "agent-codex",
				AppName: "Codex",
			},
		},
		{
			ID:          "agent-context.claude.start",
			Path:        []string{"claude", "start"},
			Summary:     "Start a Claude Code agent session",
			Description: "Start a Claude Code agent session in the current workspace.",
			InputSchema: map[string]any{"required": []string{"model", "prompt"}},
			Source: cliservice.CapabilitySource{
				Kind:    cliservice.CapabilitySourceApp,
				AppID:   "agent-claude-code",
				AppName: "Claude Code",
			},
		},
	})

	if !strings.Contains(guide, "tutti-dev codex start --prompt <prompt>") {
		t.Fatalf("guide missing codex start: %q", guide)
	}
	if !strings.Contains(guide, "tutti-dev claude start --prompt <prompt>") {
		t.Fatalf("guide missing claude start: %q", guide)
	}
	if strings.Contains(guide, "start --model <model>") {
		t.Fatalf("guide should omit agent launcher model requirement: %q", guide)
	}
	if !strings.Contains(guide, "Omit --model unless the user explicitly requested a model") {
		t.Fatalf("guide missing default model guidance: %q", guide)
	}
	if !strings.Contains(guide, "App id: agent-codex.") ||
		!strings.Contains(guide, "App id: agent-claude-code.") {
		t.Fatalf("guide missing app ids: %q", guide)
	}
}

func TestFallbackCommandGuideUsesProvidedCLIName(t *testing.T) {
	guide := commandGuide(PrepareInput{CLICommand: "tutti-dev"})

	if !strings.Contains(guide, "tutti-dev issue topic list") {
		t.Fatalf("guide = %q, want tutti-dev topic list fallback command", guide)
	}
	if !strings.Contains(guide, "tutti-dev issue list --topic-id <topic-id>") {
		t.Fatalf("guide = %q, want tutti-dev fallback command", guide)
	}
	if !strings.Contains(guide, "tutti-dev issue update --issue-id <issue-id> --status completed --json") {
		t.Fatalf("guide = %q, want tutti-dev issue update fallback command", guide)
	}
	if !strings.Contains(guide, "tutti-dev issue task run create --issue-id <issue-id> --task-id <task-id> --agent-provider <provider> --agent-session-id <session-id> --json") {
		t.Fatalf("guide = %q, want tutti-dev issue task run create fallback command", guide)
	}
	if !strings.Contains(guide, "tutti-dev issue task create --issue-id <issue-id> --title <title> --content <content> --json") ||
		!strings.Contains(guide, "persist child tasks without creating a run") {
		t.Fatalf("guide = %q, want tutti-dev breakdown task create fallback command", guide)
	}
	if !strings.Contains(guide, "tutti-dev issue task run complete --issue-id <issue-id> --task-id <task-id> --run-id <run-id> --status completed") {
		t.Fatalf("guide = %q, want tutti-dev issue task run complete fallback command", guide)
	}
	if !strings.Contains(guide, "tutti-dev app open --app-id <app-id> --json") ||
		!strings.Contains(guide, "Use only when the user explicitly asks to open or show an app window") {
		t.Fatalf("guide = %q, want guarded app open fallback command", guide)
	}
}

func TestFallbackCommandGuideDefaultsToProductionCLIName(t *testing.T) {
	guide := commandGuide(PrepareInput{})

	if !strings.Contains(guide, "tutti issue topic list") {
		t.Fatalf("guide = %q, want tutti topic list command", guide)
	}
	if !strings.Contains(guide, "tutti issue list --topic-id <topic-id>") {
		t.Fatalf("guide = %q, want tutti command", guide)
	}
	if strings.Contains(guide, "tutti-dev") {
		t.Fatalf("guide = %q, should not use development command in production", guide)
	}
}

type fakeCommandCatalog struct {
	context cliservice.InvokeContext
}

func (f *fakeCommandCatalog) Capabilities(_ context.Context, context cliservice.InvokeContext) []cliservice.Capability {
	f.context = context
	return []cliservice.Capability{
		{
			ID:      "issue-manager.issue.topic.list",
			Path:    []string{"issue", "topic", "list"},
			Summary: "List issue topics",
		},
		{
			ID:          "issue-manager.issue.list",
			Path:        []string{"issue", "list"},
			Summary:     "List issues",
			InputSchema: map[string]any{"required": []any{"topic-id"}},
		},
	}
}
