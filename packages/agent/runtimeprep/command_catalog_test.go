package runtimeprep

import (
	"context"
	"strings"
	"testing"
)

func TestCommandGuideFromCapabilitiesUsesRelevantRegistryCommands(t *testing.T) {
	guide := commandGuideFromCapabilities("tutti", []CommandCapability{
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
			Description: "List issue records in one workspace topic. Requires --topic-id; use `issue topic list --json` first when the topic is unknown. JSON output omits issue content bodies.",
			InputSchema: map[string]any{
				"properties": map[string]any{
					"topic-id": map[string]any{
						"type":        "string",
						"description": "Issue topic id.",
					},
					"status": map[string]any{
						"type":        "string",
						"description": "Optional issue status filter.",
						"enum":        []any{"open", "completed"},
						"default":     "open",
					},
				},
				"required": []any{"topic-id"},
			},
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
			ID:          "issue-manager.issue.task.create-batch",
			Path:        []string{"issue", "task", "create-batch"},
			Summary:     "Create ordered issue tasks",
			Description: "Create multiple breakdown child tasks in array order without creating a run.",
			InputSchema: map[string]any{"required": []any{"issue-id", "tasks-json"}},
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
			InputSchema: map[string]any{"required": []any{"issue-id", "task-id", "agent-target-id"}},
		},
		{
			ID:          "agent-context.agent.sessions",
			Path:        []string{"agent", "sessions"},
			Summary:     "List agent sessions",
			Description: "List agent sessions.",
		},
		{
			ID:          "agent-context.agent.wait",
			Path:        []string{"agent", "wait"},
			Summary:     "Wait for an agent session stop point",
			Description: "Wait without fetching execution messages.",
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
			Source: CommandSource{
				Kind:    CommandSourceApp,
				AppID:   "ai-media-canvas",
				AppName: "AI Canvas",
			},
		},
		{
			ID:          "app.tutti-onboarding.onboarding.read",
			Path:        []string{"onboarding", "read"},
			Summary:     "Read onboarding",
			Description: "Read onboarding guide.",
			Source: CommandSource{
				Kind:    CommandSourceApp,
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
	if !strings.Contains(guide, "use `tutti issue topic list --json` first when the topic is unknown") {
		t.Fatalf("guide missing topic discovery guidance: %q", guide)
	}
	if strings.Contains(guide, "use `issue topic list --json` first when the topic is unknown") {
		t.Fatalf("guide contains unqualified topic discovery guidance: %q", guide)
	}
	if !strings.Contains(guide, "--topic-id <string> (required) - Issue topic id.") ||
		!strings.Contains(guide, "--status <string> (optional; values: open|completed; default: open) - Optional issue status filter.") {
		t.Fatalf("guide missing argument details: %q", guide)
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
	if !strings.Contains(guide, "tutti issue task create-batch --issue-id <issue-id> --tasks-json") ||
		!strings.Contains(guide, "array order") {
		t.Fatalf("guide missing breakdown task create-batch guidance: %q", guide)
	}
	if !strings.Contains(guide, "tutti issue task run create --agent-target-id <agent-target-id> --issue-id <issue-id> --task-id <task-id> --json") {
		t.Fatalf("guide missing issue task run create: %q", guide)
	}
	if strings.Contains(guide, "run create --agent-target-id <agent-target-id> --agent-session-id") {
		t.Fatalf("guide should not require explicit agent session ids for run create: %q", guide)
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
	if !strings.Contains(guide, "tutti aimc open") ||
		!strings.Contains(guide, "Open AI Canvas. Use only when the user explicitly asks to open or show an app window") {
		t.Fatalf("guide missing guarded app-specific open: %q", guide)
	}
	if !strings.Contains(guide, "tutti onboarding read") ||
		!strings.Contains(guide, "Provided by workspace app 新手指引. App id: tutti-onboarding.") {
		t.Fatalf("guide missing app command metadata: %q", guide)
	}
	if strings.Contains(guide, "skill-bundle") {
		t.Fatalf("guide included host integration command: %q", guide)
	}
	if strings.Contains(guide, "diagnostics") {
		t.Fatalf("guide included irrelevant command: %q", guide)
	}
}

func TestCommandGuideFromCatalogPassesAgentRuntimeContext(t *testing.T) {
	catalog := fakeCommandCatalog{}
	guide := commandGuideFromCatalog(context.Background(), &catalog, "workspace-1", "tutti")
	if catalog.context.Source != "agent-runtime" || catalog.context.WorkspaceID != "workspace-1" {
		t.Fatalf("context = %#v", catalog.context)
	}
	if !catalog.context.SkipCapabilityFilters {
		t.Fatalf("context = %#v, want static capability discovery", catalog.context)
	}
	if !strings.Contains(guide, "tutti issue list") {
		t.Fatalf("guide = %q", guide)
	}
}

func TestCommandGuideHidesLegacyAgentCompatibilityAndRequiresAgentID(t *testing.T) {
	guide := commandGuideFromCapabilities("tutti", []CommandCapability{
		{ID: "agent-context.agent.providers", Path: []string{"agent", "providers"}, Summary: "Legacy providers"},
		{ID: "agent-context.codex.start", Path: []string{"codex", "start"}, Summary: "Legacy Codex"},
		{ID: "agent-context.claude.start", Path: []string{"claude", "start"}, Summary: "Legacy Claude"},
		{
			ID: "agent-context.agent.start", Path: []string{"agent", "start"}, Summary: "Start agent",
			InputSchema: map[string]any{
				"properties": map[string]any{"agent-id": map[string]any{"type": "string"}, "provider": map[string]any{"type": "string"}, "prompt": map[string]any{"type": "string"}},
				"required":   []any{"prompt"},
			},
		},
	})
	for _, forbidden := range []string{"agent providers", "codex start", "claude start", "--provider"} {
		if strings.Contains(guide, forbidden) {
			t.Fatalf("guide exposed %q: %q", forbidden, guide)
		}
	}
	if !strings.Contains(guide, "agent start --agent-id <agent-id> --prompt <prompt>") {
		t.Fatalf("guide missing target-first start: %q", guide)
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

func TestCommandGuideFromCapabilitiesUsesAgentCatalogAndGenericStart(t *testing.T) {
	guide := commandGuideFromCapabilities("tutti-dev", []CommandCapability{
		{
			ID:          "agent-context.agent.list",
			Path:        []string{"agent", "list"},
			Summary:     "List available agents",
			Description: "List every enabled agent.",
		},
		{
			ID:          "agent-context.agent.start",
			Path:        []string{"agent", "start"},
			Summary:     "Start an agent session",
			Description: "Start an agent session by agent id.",
			InputSchema: map[string]any{
				"required": []string{"agent-id", "prompt"},
				"properties": map[string]any{
					"agent-id": map[string]any{"type": "string"},
					"prompt":   map[string]any{"type": "string"},
					"model":    map[string]any{"type": "string"},
					"image":    map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
				},
			},
		},
	})

	if !strings.Contains(guide, "tutti-dev agent list") ||
		!strings.Contains(guide, "tutti-dev agent start --agent-id <agent-id> --prompt <prompt>") {
		t.Fatalf("guide missing agent catalog workflow: %q", guide)
	}
	if strings.Contains(guide, "start --model <model>") {
		t.Fatalf("guide should omit agent launcher model requirement: %q", guide)
	}
	if !strings.Contains(guide, "Omit --model unless the user explicitly requested a model") {
		t.Fatalf("guide missing default model guidance: %q", guide)
	}
	if !strings.Contains(guide, "Pass --image <path> multiple times") {
		t.Fatalf("guide missing image guidance: %q", guide)
	}
	if strings.Contains(guide, "codex start") || strings.Contains(guide, "claude start") || strings.Contains(guide, "tutti-agent start") {
		t.Fatalf("guide still exposes provider-specific launchers: %q", guide)
	}
}

func TestCommandGuideSummaryIncludesScopeDescriptions(t *testing.T) {
	guide := commandGuideFromCapabilities("tutti-dev", []CommandCapability{
		{
			ID:      "agent-context.agent.sessions",
			Path:    []string{"agent", "sessions"},
			Summary: "List agent sessions",
		},
		{
			ID:      "issue-manager.issue.topic.list",
			Path:    []string{"issue", "topic", "list"},
			Summary: "List issue topics",
		},
		{
			ID:      "workspace-apps.app.open",
			Path:    []string{"app", "open"},
			Summary: "Open a workspace app",
		},
		{
			ID:          "ai-media-canvas.aimc.open",
			Path:        []string{"aimc", "open"},
			Summary:     "Open AI Canvas",
			Description: "Open AI Canvas.",
			Source: CommandSource{
				Kind:    CommandSourceApp,
				AppID:   "ai-media-canvas",
				AppName: "AI Canvas",
			},
		},
	})
	summary := commandGuideSummary(PrepareInput{
		CLICommand:   "tutti-dev",
		CommandGuide: guide,
	})

	for _, want := range []string{
		"- `tutti-dev agent ...` - agent discovery, launches, sessions, waits, summaries, turn resources, active peers.",
		"- `tutti-dev app ...` - open/show installed app windows only when explicitly requested.",
		"- `tutti-dev issue ...` - issue/topic/task/run inspection and execution state.",
		"- `tutti-dev aimc ...` - workspace app commands for AI Canvas (App id: ai-media-canvas).",
	} {
		if !strings.Contains(summary, want) {
			t.Fatalf("summary missing %q: %q", want, summary)
		}
	}

	customGuide := strings.Join([]string{
		"- Run workspace automations: `tutti-dev automation run --json`",
		"- Inspect automation history: `tutti-dev automation history --json`",
	}, "\n")
	customSummary := commandGuideSummary(PrepareInput{
		CLICommand:   "tutti-dev",
		CommandGuide: customGuide,
	})
	wantCustom := "- `tutti-dev automation ...` - Inspect automation history; Run workspace automations."
	if !strings.Contains(customSummary, wantCustom) {
		t.Fatalf("custom summary missing %q: %q", wantCustom, customSummary)
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
	if !strings.Contains(guide, "tutti-dev issue task run create --issue-id <issue-id> --task-id <task-id> --agent-target-id <agent-target-id> --json") ||
		!strings.Contains(guide, "binds the current AgentGUI session from runtime context") {
		t.Fatalf("guide = %q, want tutti-dev issue task run create fallback command", guide)
	}
	if strings.Contains(guide, "run create --issue-id <issue-id> --task-id <task-id> --agent-target-id <agent-target-id> --agent-session-id") {
		t.Fatalf("fallback guide should not require explicit agent session ids: %q", guide)
	}
	if !strings.Contains(guide, "tutti-dev issue task create --issue-id <issue-id> --title <title> --content <content> --json") ||
		!strings.Contains(guide, "persist child tasks without creating a run") {
		t.Fatalf("guide = %q, want tutti-dev breakdown task create fallback command", guide)
	}
	if !strings.Contains(guide, "tutti-dev issue task create-batch --issue-id <issue-id> --tasks-json") ||
		!strings.Contains(guide, "Prefer this for multiple child tasks") {
		t.Fatalf("guide = %q, want tutti-dev breakdown task create-batch fallback command", guide)
	}
	if !strings.Contains(guide, "tutti-dev issue task run complete --issue-id <issue-id> --task-id <task-id> --run-id <run-id> --status completed") {
		t.Fatalf("guide = %q, want tutti-dev issue task run complete fallback command", guide)
	}
	if !strings.Contains(guide, "tutti-dev agent wait --session-id <session-id> --json") ||
		!strings.Contains(guide, "use `agent session-summary` when you need the full compact session context") {
		t.Fatalf("guide = %q, want tutti-dev await fallback command", guide)
	}
	if !strings.Contains(guide, "tutti-dev agent list --json") ||
		!strings.Contains(guide, "tutti-dev agent start --agent-id <agent-id> --prompt <prompt> --json") {
		t.Fatalf("guide = %q, want agent catalog/start fallback commands", guide)
	}
	if !strings.Contains(guide, "tutti-dev agent turn-resources --session-id <session-id> --turn-id <turn-id> --json") {
		t.Fatalf("guide = %q, want tutti-dev turn resources fallback command", guide)
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
	context CommandContext
}

func (f *fakeCommandCatalog) Capabilities(_ context.Context, context CommandContext) []CommandCapability {
	f.context = context
	return []CommandCapability{
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
