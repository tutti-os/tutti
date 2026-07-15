package agent

import (
	"context"
	"testing"

	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
)

func TestServiceCreateDerivesInitialTitleOnlyForEligibleRuntimeSession(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{
		ID:                      "session-1",
		WorkspaceID:             "ws-1",
		AgentTargetID:           agenttargetbiz.IDLocalCodex,
		Provider:                "codex",
		InitialTitleEstablished: true,
		Status:                  "ready",
	}
	service := newTestService(runtime)

	if _, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentSessionID: "session-1",
		AgentTargetID:  agenttargetbiz.IDLocalCodex,
		InitialContent: TextPromptContent("later prompt"),
	}); err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if got := runtime.execCalls[0].InitialTitle; got != "" {
		t.Fatalf("InitialTitle = %q, want empty for established session", got)
	}
}

func TestServiceSendInputUsesRuntimeInitialTitleStateWithoutMessageReader(t *testing.T) {
	for _, test := range []struct {
		name        string
		established bool
		wantTitle   string
	}{
		{name: "eligible", established: false, wantTitle: "first prompt"},
		{name: "established", established: true, wantTitle: ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			runtime := newFakeRuntime()
			runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{
				ID:                      "session-1",
				WorkspaceID:             "ws-1",
				AgentTargetID:           agenttargetbiz.IDLocalCodex,
				Provider:                "codex",
				InitialTitleEstablished: test.established,
				Status:                  "ready",
			}
			service := newTestService(runtime)

			if _, err := service.SendInput(
				context.Background(),
				"ws-1",
				"session-1",
				SendInput{Content: TextPromptContent("first prompt")},
			); err != nil {
				t.Fatalf("SendInput() error = %v", err)
			}
			if got := runtime.execCalls[0].InitialTitle; got != test.wantTitle {
				t.Fatalf("InitialTitle = %q, want %q", got, test.wantTitle)
			}
		})
	}
}

func TestServiceCreateUsesCanonicalTitleToEstablishInitialTitleState(t *testing.T) {
	runtime := newFakeRuntime()
	service := newTestService(runtime)
	title := "[](mention://empty-label)"

	if _, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentSessionID: "session-1",
		AgentTargetID:  agenttargetbiz.IDLocalCodex,
		Title:          &title,
	}); err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if runtime.startCalls[0].InitialTitleEstablished {
		t.Fatal("InitialTitleEstablished = true, want false for empty canonical title")
	}
}
