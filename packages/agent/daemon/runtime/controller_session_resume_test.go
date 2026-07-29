package agentruntime

import (
	"context"
	"errors"
	"testing"
)

type unavailableResumeAdapterResolver struct{}

func (unavailableResumeAdapterResolver) ResolveAdapter(context.Context, AdapterResolveInput) (Adapter, error) {
	return nil, errors.New("adapter resolution must not run during resume eligibility checks")
}

func TestControllerCanResumeAuthorizedAgentExtensionBinding(t *testing.T) {
	controller := NewControllerWithAdapterResolver(nil, nil, unavailableResumeAdapterResolver{})
	valid := ResumeInput{
		RoomID:            "workspace-1",
		AgentSessionID:    "session-1",
		AgentTargetID:     "extension:codebuddy",
		Provider:          "acp:codebuddy",
		ProviderSessionID: "provider-session-1",
		ProviderTargetRef: map[string]any{
			"kind":                    "agent_extension",
			"provider":                "acp:codebuddy",
			"targetId":                "extension:codebuddy",
			"extensionInstallationId": "codebuddy@1.0.0",
		},
	}

	tests := []struct {
		name   string
		mutate func(*ResumeInput)
		want   bool
	}{
		{name: "authorized after controller restart", want: true},
		{name: "missing target ref", mutate: func(input *ResumeInput) { input.ProviderTargetRef = nil }},
		{name: "missing provider session", mutate: func(input *ResumeInput) { input.ProviderSessionID = "" }},
		{name: "provider mismatch", mutate: func(input *ResumeInput) { input.ProviderTargetRef["provider"] = "acp:other" }},
		{name: "target mismatch", mutate: func(input *ResumeInput) { input.ProviderTargetRef["targetId"] = "extension:other" }},
		{name: "missing installation", mutate: func(input *ResumeInput) { delete(input.ProviderTargetRef, "extensionInstallationId") }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			input := valid
			input.ProviderTargetRef = clonePayload(valid.ProviderTargetRef)
			if tt.mutate != nil {
				tt.mutate(&input)
			}
			if got := controller.CanResume(input); got != tt.want {
				t.Fatalf("CanResume() = %t, want %t", got, tt.want)
			}
		})
	}
}
