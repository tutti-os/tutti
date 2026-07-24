package agent

import (
	"context"
	"errors"
	"testing"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
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

func TestHostCreateWithInvalidTypedGoalPreservesPublishedSession(t *testing.T) {
	ctx := context.Background()
	runtime := newFakeRuntime()
	store := openAgentServiceSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-goal", Name: "Goal workspace"}); err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	projection := NewActivityProjection(store)
	publisher := &activityUpdatePublisherStub{}
	projection.SetPublisher(publisher)
	service := newTestService(runtime)
	service.SessionReader = projection
	service.SessionInitializer = projection
	service.GoalStateStore = store

	_, err := service.Create(ctx, "ws-goal", CreateSessionInput{
		AgentSessionID: "session-invalid-goal", AgentTargetID: agenttargetbiz.IDLocalCodex,
		InitialContent: TextPromptContent("/goal pause"),
	})
	if !errors.Is(err, storesqlite.ErrGoalStateAbsent) {
		t.Fatalf("Create() error=%v, want %v", err, storesqlite.ErrGoalStateAbsent)
	}
	if _, found, getErr := store.GetSession(ctx, "ws-goal", "session-invalid-goal"); getErr != nil || !found {
		t.Fatalf("published canonical session found=%v error=%v", found, getErr)
	}
	if len(publisher.events) != 1 {
		t.Fatalf("published session event count=%d, want 1", len(publisher.events))
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
	}, nil)
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
