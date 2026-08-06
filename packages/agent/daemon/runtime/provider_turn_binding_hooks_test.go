package agentruntime

import (
	"encoding/json"
	"testing"
)

func TestProviderTurnBindingHooksOwnForkability(t *testing.T) {
	t.Parallel()
	claude := new(ClaudeCodeSDKAdapter)
	claudeSession := Session{ProviderSessionID: "claude-session-1"}
	started, err := claude.WriteProviderTurnBinding(
		ProviderTurnBindingWriteInput{
			Kind:           ProviderTurnBindingWriteStarted,
			Source:         claudeSession,
			ProviderTurnID: "claude-prompt",
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	forkable, err := claude.CanForkProviderTurn(
		t.Context(),
		ProviderTurnForkabilityInput{
			Source:                  claudeSession,
			ProviderTurnID:          "claude-prompt",
			ProviderTurnBindingJSON: started,
		},
	)
	if err != nil || forkable {
		t.Fatalf("Claude started binding forkable=%v error=%v", forkable, err)
	}
	checkpoint, err := claude.WriteProviderTurnBinding(
		ProviderTurnBindingWriteInput{
			Kind:           ProviderTurnBindingWriteCheckpoint,
			Source:         claudeSession,
			ProviderTurnID: "claude-prompt",
			Payload: map[string]any{
				"checkpointMessageId": "claude-answer",
			},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	forkable, err = claude.CanForkProviderTurn(
		t.Context(),
		ProviderTurnForkabilityInput{
			Source:                  claudeSession,
			ProviderTurnID:          "claude-prompt",
			ProviderTurnBindingJSON: checkpoint,
		},
	)
	if err != nil || !forkable {
		t.Fatalf("Claude checkpoint binding forkable=%v error=%v", forkable, err)
	}
	forkable, err = claude.CanForkProviderTurn(
		t.Context(),
		ProviderTurnForkabilityInput{
			Source:                  claudeSession,
			ProviderTurnID:          "claude-legacy-prompt",
			ProviderTurnBindingJSON: json.RawMessage(`{"schemaVersion":1,"checkpointMessageId":"legacy-answer"}`),
		},
	)
	if err != nil || !forkable {
		t.Fatalf("legacy Claude binding forkable=%v error=%v", forkable, err)
	}
	forkable, err = claude.CanForkProviderTurn(
		t.Context(),
		ProviderTurnForkabilityInput{
			Source: Session{ProviderSessionID: "claude-session-2", RuntimeContext: map[string]any{
				claudeSDKContextRecoveryRuntimeKey: map[string]any{
					"generation": 1,
					"state":      claudeSDKContextRecoveryStateCompleted,
				},
			}},
			ProviderTurnID:          "claude-prompt",
			ProviderTurnBindingJSON: checkpoint,
		},
	)
	if err != nil || forkable {
		t.Fatalf("recovered Claude session binding forkable=%v error=%v", forkable, err)
	}
	recoveredSession := Session{
		ProviderSessionID: "claude-session-2",
		RuntimeContext: map[string]any{
			claudeSDKContextRecoveryRuntimeKey: map[string]any{
				"generation": 1,
				"state":      claudeSDKContextRecoveryStateCompleted,
			},
		},
	}
	recoveredCheckpoint, err := claude.WriteProviderTurnBinding(
		ProviderTurnBindingWriteInput{
			Kind:           ProviderTurnBindingWriteCheckpoint,
			Source:         recoveredSession,
			ProviderTurnID: "claude-prompt-2",
			Payload: map[string]any{
				"checkpointMessageId": "claude-answer-2",
			},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	forkable, err = claude.CanForkProviderTurn(t.Context(), ProviderTurnForkabilityInput{
		Source:                  recoveredSession,
		ProviderTurnID:          "claude-prompt-2",
		ProviderTurnBindingJSON: recoveredCheckpoint,
	})
	if err != nil || !forkable {
		t.Fatalf("current recovered Claude binding forkable=%v error=%v", forkable, err)
	}

	codex := new(CodexAppServerAdapter)
	binding, err := codex.WriteProviderTurnBinding(
		ProviderTurnBindingWriteInput{
			Kind:           ProviderTurnBindingWriteStarted,
			ProviderTurnID: "codex-turn",
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	forkable, err = codex.CanForkProviderTurn(
		t.Context(),
		ProviderTurnForkabilityInput{
			ProviderTurnID:          "codex-turn",
			ProviderTurnBindingJSON: binding,
		},
	)
	if err != nil || !forkable {
		t.Fatalf("Codex binding forkable=%v error=%v", forkable, err)
	}

	tuttiAgent := NewTuttiAgentAppServerAdapterWithHostMetadata(
		nil,
		LegacyHostMetadata(),
	)
	tuttiBinding, err := tuttiAgent.WriteProviderTurnBinding(
		ProviderTurnBindingWriteInput{
			Kind:           ProviderTurnBindingWriteStarted,
			ProviderTurnID: "tutti-turn",
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	forkable, err = tuttiAgent.CanForkProviderTurn(
		t.Context(),
		ProviderTurnForkabilityInput{
			ProviderTurnID:          "tutti-turn",
			ProviderTurnBindingJSON: tuttiBinding,
		},
	)
	if err != nil || !forkable {
		t.Fatalf("Tutti Agent binding forkable=%v error=%v", forkable, err)
	}

	forkable, err = codex.CanForkProviderTurn(
		t.Context(),
		ProviderTurnForkabilityInput{
			ProviderTurnID:          "codex-turn",
			ProviderTurnBindingJSON: json.RawMessage(`{}`),
		},
	)
	if err != nil || forkable {
		t.Fatalf("historical empty binding forkable=%v error=%v", forkable, err)
	}
}
