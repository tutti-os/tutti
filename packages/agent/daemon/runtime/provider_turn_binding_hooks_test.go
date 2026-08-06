package agentruntime

import (
	"encoding/json"
	"testing"
)

func TestProviderTurnBindingHooksOwnForkability(t *testing.T) {
	t.Parallel()
	claude := new(ClaudeCodeSDKAdapter)
	started, err := claude.WriteProviderTurnBinding(
		ProviderTurnBindingWriteInput{
			Kind:           ProviderTurnBindingWriteStarted,
			ProviderTurnID: "claude-prompt",
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	forkable, err := claude.CanForkProviderTurn(
		t.Context(),
		ProviderTurnForkabilityInput{
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
			Source: Session{RuntimeContext: map[string]any{
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
