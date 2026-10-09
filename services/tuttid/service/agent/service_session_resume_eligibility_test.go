package agent

import (
	"context"
	"testing"

	agentactivitybiz "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	workspaceagentbiz "github.com/tutti-os/tutti/services/tuttid/biz/workspaceagent"
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

func TestPersistedSessionCanResumeUsesRecordedHarness(t *testing.T) {
	const (
		provider             = "acp:example"
		agentTargetID        = "workspace-agent:writer"
		recordedHarnessID    = "extension:example-v1"
		currentHarnessID     = "extension:example-v2"
		recordedInstallation = "example@1.0.0"
		currentInstallation  = "example@2.0.0"
	)
	runtime := newFakeRuntime()
	runtime.canResumeHook = func(input RuntimeResumeInput) bool {
		return input.ProviderTargetRef["targetId"] == currentHarnessID
	}
	service := newIsolatedAgentService(runtime)
	service.WorkspaceAgentResolver = staticWorkspaceAgentResolver{resolved: workspaceagentbiz.Resolved{
		Agent: workspaceagentbiz.Agent{
			ID:                   agentTargetID,
			WorkspaceID:          "workspace-1",
			HarnessAgentTargetID: currentHarnessID,
			Revision:             2,
		},
		HarnessTarget: agenttargetbiz.Target{
			ID:            currentHarnessID,
			Provider:      provider,
			LaunchRefJSON: `{"type":"agent_extension","extensionInstallationId":"` + currentInstallation + `"}`,
			Name:          "Example v2",
			Enabled:       true,
			Source:        agenttargetbiz.SourceUser,
		},
	}}
	service.AgentTargetStore = fakeAgentTargetStore{targets: map[string]agenttargetbiz.Target{
		recordedHarnessID: {
			ID:            recordedHarnessID,
			Provider:      provider,
			LaunchRefJSON: `{"type":"agent_extension","extensionInstallationId":"` + recordedInstallation + `"}`,
			Name:          "Example v1",
			Enabled:       false,
			Source:        agenttargetbiz.SourceUser,
		},
	}}
	runtimeContext := runtimeContextWithSessionRuntimeSnapshot(
		nil,
		CreateSessionInput{
			AgentTargetID:        agentTargetID,
			HarnessAgentTargetID: recordedHarnessID,
		},
		provider,
		modelPlanResolution{ModelConfiguration: newProviderNativeModelConfiguration(provider, agentTargetID)},
	)
	runtimeContext = stampAgentExtensionComposerScope(
		runtimeContext,
		map[string]any{
			"kind":                    agenttargetbiz.LaunchRefTypeAgentExtension,
			"extensionInstallationId": recordedInstallation,
		},
		"/repo",
		ComposerSettings{},
	)

	if service.persistedSessionCanResume(context.Background(), PersistedSession{
		ID:                     "session-1",
		WorkspaceID:            "workspace-1",
		AgentTargetID:          agentTargetID,
		Provider:               provider,
		ProviderSessionID:      "provider-session-1",
		Cwd:                    "/repo",
		InternalRuntimeContext: runtimeContext,
	}) {
		t.Fatal("persistedSessionCanResume() = true, want false for disabled recorded Harness")
	}
}
