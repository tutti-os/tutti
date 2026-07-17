package workspaceagent

import (
	"errors"
	"strings"
	"testing"
)

func TestNormalizeCanonicalizesLists(t *testing.T) {
	agent, err := Normalize(Agent{
		ID:                   " workspace-agent:one ",
		WorkspaceID:          " ws ",
		Name:                 " Builder ",
		HarnessAgentTargetID: " local:codex ",
		Skills:               []string{" review ", "review", ""},
		Tools:                nil,
		Source:               SourceUser,
		Revision:             1,
	})
	if err != nil {
		t.Fatalf("Normalize() error = %v", err)
	}
	if agent.ID != "workspace-agent:one" || agent.WorkspaceID != "ws" || agent.Name != "Builder" {
		t.Fatalf("Normalize() identity = %#v", agent)
	}
	if len(agent.Skills) != 1 || agent.Skills[0] != "review" {
		t.Fatalf("Normalize() skills = %#v", agent.Skills)
	}
	if agent.Tools == nil || len(agent.Tools) != 0 {
		t.Fatalf("Normalize() tools = %#v, want non-nil empty", agent.Tools)
	}
}

func TestNormalizeLengthLimitsCountUnicodeCharacters(t *testing.T) {
	_, err := Normalize(Agent{
		ID:                   "workspace-agent:unicode",
		WorkspaceID:          "ws",
		Name:                 strings.Repeat("智", 120),
		HarnessAgentTargetID: "local:codex",
		Source:               SourceUser,
		Revision:             1,
	})
	if err != nil {
		t.Fatalf("Normalize() 120-character name error = %v", err)
	}
}

func TestNormalizeRejectsDefaultModelWithoutPlan(t *testing.T) {
	_, err := Normalize(Agent{
		ID:                   "workspace-agent:one",
		WorkspaceID:          "ws",
		Name:                 "Builder",
		HarnessAgentTargetID: "local:codex",
		DefaultModel:         "gpt-5",
		Source:               SourceUser,
		Revision:             1,
	})
	if !errors.Is(err, ErrInvalidAgent) {
		t.Fatalf("Normalize() error = %v, want ErrInvalidAgent", err)
	}
}

func TestLegacyBindingIDIsStableAndScoped(t *testing.T) {
	first := LegacyBindingID("ws-one", "local:codex")
	if first != LegacyBindingID("ws-one", "local:codex") {
		t.Fatal("LegacyBindingID() is not stable")
	}
	if first == LegacyBindingID("ws-two", "local:codex") {
		t.Fatal("LegacyBindingID() is not workspace scoped")
	}
	if first == LegacyBindingID("ws-one", "local:claude-code") {
		t.Fatal("LegacyBindingID() is not harness scoped")
	}
}
