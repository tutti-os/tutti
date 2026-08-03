package agent

import (
	"context"
	"errors"
	"testing"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
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

func TestHostCreateRetainsVisibleFailedTurnAfterExplicitProviderRejection(t *testing.T) {
	ctx := context.Background()
	execErr := &agenthost.ProviderError{
		Code:    "auth_required",
		Message: "Claude Code needs authentication",
	}
	runtime := newFakeRuntime()
	store := openAgentServiceSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-rejected", Name: "Workspace"}); err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	projection := NewActivityProjection(store)
	publisher := &activityUpdatePublisherStub{}
	projection.SetPublisher(publisher)
	runtime.execHook = func(input RuntimeExecInput) (RuntimeExecResult, error) {
		if err := projection.Report(ctx, agentsessionstore.ReportActivityInput{
			WorkspaceID: input.WorkspaceID,
			Source: canonical.EventSource{
				AgentID: input.AgentSessionID, Provider: "claude-code",
				SessionOrigin: agentsessionstore.WorkspaceAgentSessionOriginRuntime,
			},
			StatePatches: []agentsessionstore.WorkspaceAgentStatePatch{{
				AgentSessionID: input.AgentSessionID, Kind: storesqlite.SessionKindRoot,
				Provider: "claude-code", CurrentPhase: "submitted", OccurredAtUnixMS: 2,
				RuntimeContext: map[string]any{"visible": true, "provisional": false},
				Turn: &agentsessionstore.WorkspaceAgentTurnPatch{
					TurnID: input.TurnID, Origin: storesqlite.TurnOriginUserPrompt,
					Phase: storesqlite.TurnPhaseSubmitted,
				},
			}},
		}); err != nil {
			return RuntimeExecResult{}, err
		}
		return RuntimeExecResult{
			AgentSessionID: input.AgentSessionID,
			TurnID:         input.TurnID,
			ProviderDispatch: agenthost.RuntimeProviderDispatchResult{
				Disposition: agenthost.RuntimeDispatchDispositionRejected,
			},
		}, execErr
	}
	runtime.provenanceHook = func(input RuntimeSubmitProvenanceInput) error {
		content := "start atomically"
		if len(input.Content) > 0 && input.Content[0].Text != "" {
			content = input.Content[0].Text
		}
		return projection.ReportSubmitProvenance(ctx, agentsessionstore.ReportActivityInput{
			WorkspaceID: input.WorkspaceID,
			Source: canonical.EventSource{
				AgentID: input.AgentSessionID, Provider: "claude-code",
				SessionOrigin: agentsessionstore.WorkspaceAgentSessionOriginRuntime,
			},
			StatePatches: []agentsessionstore.WorkspaceAgentStatePatch{{
				AgentSessionID: input.AgentSessionID, Kind: storesqlite.SessionKindRoot,
				Provider: "claude-code", LifecycleStatus: "failed", CurrentPhase: "failed",
				LastError: execErr.Error(), OccurredAtUnixMS: input.CanonicalSubmitOccurredAtUnixMS + 1,
				RuntimeContext: map[string]any{"visible": true, "provisional": false},
				Turn: &agentsessionstore.WorkspaceAgentTurnPatch{
					TurnID: input.TurnID, Origin: storesqlite.TurnOriginUserPrompt,
					Phase: storesqlite.TurnPhaseSettled, Outcome: storesqlite.TurnOutcomeFailed,
				},
			}},
			MessageUpdates: []agentsessionstore.WorkspaceAgentMessageUpdate{{
				AgentSessionID: input.AgentSessionID,
				MessageID:      "client-submit:user:" + input.ClientSubmitID,
				TurnID:         input.TurnID, Role: "user", Kind: "text", Status: "completed",
				OccurredAtUnixMS: input.CanonicalSubmitOccurredAtUnixMS,
				Payload: map[string]any{
					"clientSubmitId":          input.ClientSubmitID,
					"clientSubmittedAtUnixMs": input.CanonicalSubmitOccurredAtUnixMS,
					"content":                 []map[string]any{{"type": "text", "text": content}},
					"contentMode":             "snapshot", "source": "host", "text": content,
				},
			}},
		})
	}
	service := newTestService(runtime)
	service.SessionReader = projection
	service.SessionInitializer = projection
	service.SubmitClaimStore = store
	service.TurnStore = store

	input := CreateSessionInput{
		AgentSessionID: "session-rejected", AgentTargetID: agenttargetbiz.IDLocalClaudeCode,
		InitialContent: TextPromptContent("start atomically"),
		ClientSubmitID: "submit-rejected",
	}
	_, err := service.Create(ctx, "ws-rejected", input)
	if !errors.Is(err, execErr) {
		t.Fatalf("Create() error=%v, want %v", err, execErr)
	}
	session, ok, err := store.GetSession(ctx, "ws-rejected", "session-rejected")
	if err != nil || !ok {
		t.Fatalf("canonical session after rejection ok=%v error=%v", ok, err)
	}
	if !session.Metadata.Visible {
		t.Fatalf("canonical session after rejection visible=%v, want true", session.Metadata.Visible)
	}
	turn, ok, err := store.GetTurn(ctx, "ws-rejected", "session-rejected", runtime.execCalls[0].TurnID)
	if err != nil || !ok {
		t.Fatalf("canonical Turn after rejection ok=%v error=%v", ok, err)
	}
	if turn.Phase != storesqlite.TurnPhaseSettled || turn.Outcome != storesqlite.TurnOutcomeFailed {
		t.Fatalf("canonical Turn after rejection = %#v, want settled/failed", turn)
	}
	page, ok, err := store.ListSessionMessages(ctx, storesqlite.ListSessionMessagesInput{
		WorkspaceID: "ws-rejected", AgentSessionID: "session-rejected", Order: storesqlite.MessageOrderAsc, Limit: 10,
	})
	if err != nil || !ok || len(page.Messages) != 1 {
		t.Fatalf("canonical messages after rejection page=%#v ok=%v error=%v session=%#v provenance=%#v", page, ok, err, session, runtime.provenanceCalls)
	}
	if page.Messages[0].Payload["text"] != "start atomically" {
		t.Fatalf("canonical prompt after rejection payload=%#v", page.Messages[0].Payload)
	}
	if len(runtime.provenanceCalls) != 1 {
		t.Fatalf("submit provenance calls=%d, want 1", len(runtime.provenanceCalls))
	}
	if len(publisher.events) == 0 {
		t.Fatal("rejected visible create did not publish canonical updates")
	}
	claim, found, err := store.GetSubmitClaim(ctx, "ws-rejected", input.AgentSessionID, input.ClientSubmitID)
	if err != nil || !found || claim.Status != "rejected" || claim.TurnID != runtime.execCalls[0].TurnID {
		t.Fatalf("rejected submit claim=%#v found=%v error=%v", claim, found, err)
	}
	startCalls, execCalls, provenanceCalls := len(runtime.startCalls), len(runtime.execCalls), len(runtime.provenanceCalls)
	replayed, retryErr := service.CreateWithResult(ctx, "ws-rejected", input)
	if retryErr != nil || replayed.TurnID != claim.TurnID {
		t.Fatalf("replayed CreateWithResult=%#v error=%v, want terminal failed Turn %q", replayed, retryErr, claim.TurnID)
	}
	if len(runtime.startCalls) != startCalls || len(runtime.execCalls) != execCalls || len(runtime.provenanceCalls) != provenanceCalls {
		t.Fatalf("replayed rejected submit touched runtime: starts=%d exec=%d provenance=%d, want %d/%d/%d", len(runtime.startCalls), len(runtime.execCalls), len(runtime.provenanceCalls), startCalls, execCalls, provenanceCalls)
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
