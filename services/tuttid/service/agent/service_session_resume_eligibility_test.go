package agent

import (
	"context"
	"testing"

	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
)

func TestServiceListRebuildsExtensionTargetRefForPersistedSessionResume(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.canResumeHook = func(input RuntimeResumeInput) bool {
		return input.ProviderTargetRef["kind"] == agenttargetbiz.LaunchRefTypeAgentExtension
	}
	service := newIsolatedAgentService(runtime)
	service.AgentTargetStore = fakeAgentTargetStore{targets: map[string]agenttargetbiz.Target{
		"extension:codebuddy": {
			ID:            "extension:codebuddy",
			Provider:      "acp:codebuddy",
			LaunchRefJSON: `{"type":"agent_extension","extensionInstallationId":"codebuddy@1.0.0"}`,
			Name:          "CodeBuddy",
			Enabled:       true,
			Source:        agenttargetbiz.SourceUser,
		},
	}}
	service.SessionReader = fakeSessionReader{sessions: map[string]PersistedSession{
		"workspace-1:session-1": {
			ID:                "session-1",
			WorkspaceID:       "workspace-1",
			Kind:              agentactivitybiz.SessionKindRoot,
			AgentTargetID:     "extension:codebuddy",
			Provider:          "acp:codebuddy",
			ProviderSessionID: "provider-session-1",
			RailSectionKey:    "conversations",
			Metadata:          agentactivitybiz.SessionMetadata{Visible: true},
		},
	}}

	sessions, err := service.List(context.Background(), "workspace-1")
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if len(sessions) != 1 || !sessions[0].Resumable {
		t.Fatalf("sessions = %#v, want one resumable persisted extension session", sessions)
	}
	if len(runtime.canResumeCalls) != 1 {
		t.Fatalf("CanResume calls = %d, want 1", len(runtime.canResumeCalls))
	}
	input := runtime.canResumeCalls[0]
	if input.ProviderTargetRef["provider"] != "acp:codebuddy" ||
		input.ProviderTargetRef["targetId"] != "extension:codebuddy" ||
		input.ProviderTargetRef["extensionInstallationId"] != "codebuddy@1.0.0" {
		t.Fatalf("provider target ref = %#v, want fixed CodeBuddy installation binding", input.ProviderTargetRef)
	}
}
