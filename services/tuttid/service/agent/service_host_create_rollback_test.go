package agent

import (
	"context"
	"errors"
	"testing"

	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
)

func TestHostCreateWithInitialInputRollsBackTurnlessCanonicalShell(t *testing.T) {
	execErr := errors.New("provider rejected initial input")
	runtime := newFakeRuntime()
	runtime.execErr = execErr
	store := openAgentServiceSQLiteStore(t)
	if err := store.Create(context.Background(), workspacebiz.Summary{ID: "ws-1", Name: "Workspace"}); err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	projection := NewActivityProjection(store)
	publisher := &activityUpdatePublisherStub{}
	projection.SetPublisher(publisher)
	service := newTestService(runtime)
	service.SessionReader = projection
	service.SessionInitializer = projection

	_, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentSessionID: "session-no-turnless-shell", AgentTargetID: agenttargetbiz.IDLocalCodex,
		InitialContent: TextPromptContent("start atomically"),
	})
	if !errors.Is(err, execErr) {
		t.Fatalf("Create() error=%v, want %v", err, execErr)
	}
	if _, ok, err := store.GetSession(context.Background(), "ws-1", "session-no-turnless-shell"); err != nil || ok {
		t.Fatalf("canonical shell after failed initial input ok=%v error=%v", ok, err)
	}
	if len(publisher.events) != 0 {
		t.Fatalf("failed provisional create published turnless session events=%#v", publisher.events)
	}
}

func TestProvisionalRuntimeSessionShellIsHiddenAndUnpublished(t *testing.T) {
	store := openAgentServiceSQLiteStore(t)
	if err := store.Create(context.Background(), workspacebiz.Summary{ID: "ws-1", Name: "Workspace"}); err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	projection := NewActivityProjection(store)
	publisher := &activityUpdatePublisherStub{}
	projection.SetPublisher(publisher)

	persisted, err := projection.InitializeRuntimeSession(context.Background(), ProviderRuntimeSession{
		ID: "session-provisional", WorkspaceID: "ws-1", Provider: "codex",
		Status: "ready", Visible: true, Provisional: true, CreatedAtUnixMS: 1, UpdatedAtUnixMS: 1,
	})
	if err != nil {
		t.Fatalf("InitializeRuntimeSession() error=%v", err)
	}
	if persisted.Metadata.Visible {
		t.Fatalf("provisional canonical shell visible=%v, want false", persisted.Metadata.Visible)
	}
	if len(publisher.events) != 0 {
		t.Fatalf("provisional canonical shell published events=%#v", publisher.events)
	}
}
