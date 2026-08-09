package sessionreplay

import (
	"path/filepath"
	"testing"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
)

func TestRewriteReplayAgentTargetFieldsRewritesNestedStateWithoutMutation(t *testing.T) {
	original := TuttiReplayState{
		SchemaVersion: SchemaVersion,
		Agent: agenthost.HistoricalSessionGraph{
			RootSessionID: "root-1",
			Sessions: []agenthost.HistoricalSession{{
				ID:            "root-1",
				AgentTargetID: "shared-agent:recorded",
				Messages: []agenthost.HistoricalMessage{{
					ID:      "message-1",
					Payload: map[string]any{"agentTargetId": "shared-agent:recorded"},
				}},
			}},
		},
	}

	rewritten, err := rewriteReplayAgentTargetFields(original, map[string]string{
		"shared-agent:recorded": "shared-agent:runtime",
	})
	if err != nil {
		t.Fatal(err)
	}
	if rewritten.Agent.Sessions[0].AgentTargetID != "shared-agent:runtime" {
		t.Fatalf("rewritten session target = %q", rewritten.Agent.Sessions[0].AgentTargetID)
	}
	if rewritten.Agent.Sessions[0].Messages[0].Payload["agentTargetId"] != "shared-agent:runtime" {
		t.Fatalf("rewritten nested target = %#v", rewritten.Agent.Sessions[0].Messages[0].Payload)
	}
	if original.Agent.Sessions[0].AgentTargetID != "shared-agent:recorded" {
		t.Fatalf("source state was mutated: %q", original.Agent.Sessions[0].AgentTargetID)
	}
}

func TestNormalizeReplayAgentTargetRewritesRejectsEmptyIdentity(t *testing.T) {
	if _, err := normalizeReplayAgentTargetRewrites(map[string]string{"": "shared-agent:runtime"}); err == nil {
		t.Fatal("empty recorded target was accepted")
	}
	if _, err := normalizeReplayAgentTargetRewrites(map[string]string{"shared-agent:recorded": ""}); err == nil {
		t.Fatal("empty runtime target was accepted")
	}
}

func TestProjectPortableAgentStateUsesProviderDescriptorForSharedTarget(t *testing.T) {
	stateDirectory := t.TempDir()
	generatedPath := filepath.Join(
		stateDirectory,
		"agent",
		"runs",
		"session-1",
		"codex-home",
		"generated_images",
		"image.png",
	)
	state := TuttiReplayAgent{
		RootSessionID: "session-1",
		Sessions: []agenthost.HistoricalSession{{
			ID:            "session-1",
			AgentTargetID: "shared-agent:runtime",
			Provider:      "codex",
			Messages: []agenthost.HistoricalMessage{{
				ID:      "tool-message",
				Kind:    "tool_call",
				Payload: map[string]any{"output": map[string]any{"savedPath": generatedPath}},
			}},
		}},
	}

	projected := ProjectPortableAgentState(state, stateDirectory)
	output := projected.Sessions[0].Messages[0].Payload["output"].(map[string]any)
	if output["savedPath"] != PortableReplayHomeToken+"/generated_images/image.png" {
		t.Fatalf("shared target generated image path = %#v", output)
	}
}
