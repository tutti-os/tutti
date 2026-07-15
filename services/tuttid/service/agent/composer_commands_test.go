package agent

import (
	"context"
	"testing"
)

type composerCommandSessionReaderStub struct {
	sessions []PersistedSession
}

func (composerCommandSessionReaderStub) GetSession(string, string) (PersistedSession, bool) {
	return PersistedSession{}, false
}

func (s composerCommandSessionReaderStub) ListSessions(string) ([]PersistedSession, bool) {
	return s.sessions, true
}

func (composerCommandSessionReaderStub) SessionDeleted(context.Context, string, string) (bool, error) {
	return false, nil
}

func TestComposerCommandsFromRuntimeContextPrefersDetailedCatalog(t *testing.T) {
	commands := composerCommandsFromRuntimeContext(map[string]any{
		"availableCommands": []any{
			map[string]any{"name": "memory", "description": "Manage memory", "inputHint": "show"},
			map[string]any{"name": "memory"},
			map[string]any{"description": "invalid"},
		},
		"commands": []string{"legacy"},
	})
	if len(commands) != 1 || commands[0]["name"] != "memory" || commands[0]["description"] != "Manage memory" || commands[0]["inputHint"] != "show" {
		t.Fatalf("commands = %#v", commands)
	}
}

func TestComposerCommandsFromRuntimeContextRestoresLegacyNames(t *testing.T) {
	commands := composerCommandsFromRuntimeContext(map[string]any{
		"commands": []any{"memory", "help", "memory", " "},
	})
	if len(commands) != 2 || commands[0]["name"] != "memory" || commands[1]["name"] != "help" {
		t.Fatalf("commands = %#v", commands)
	}
}

func TestComposerCommandsRestoreLatestPersistedExtensionSession(t *testing.T) {
	service := newIsolatedAgentService(newFakeRuntime())
	service.SessionReader = composerCommandSessionReaderStub{sessions: []PersistedSession{
		{
			Provider:               "acp:gemini",
			AgentTargetID:          "extension:gemini",
			UpdatedAtUnixMS:        10,
			InternalRuntimeContext: map[string]any{"commands": []string{"old"}},
		},
		{
			Provider:               "acp:gemini",
			AgentTargetID:          "extension:gemini",
			UpdatedAtUnixMS:        20,
			InternalRuntimeContext: map[string]any{"commands": []string{"memory", "help"}},
		},
	}}
	commands := service.composerCommandsFromRunningSession(
		"workspace-1",
		"acp:gemini",
		"extension:gemini",
	)
	if len(commands) != 2 || commands[0]["name"] != "memory" || commands[1]["name"] != "help" {
		t.Fatalf("commands = %#v", commands)
	}
}
