package automationrule

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
	automationrulebiz "github.com/tutti-os/tutti/services/tuttid/biz/automationrule"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
)

type noopActivityPublisher struct{}

func (noopActivityPublisher) PublishAgentActivityUpdated(
	context.Context,
	string,
	string,
	string,
	map[string]any,
) error {
	return nil
}

// TestAutomationRuleFiresFromLiveRootProviderTurnSettlement replays the exact
// state-patch sequence a live codex (root-provider-lifecycle) session reports
// through the durable activity projection:
//
//  1. the adapter's stamped EventTurnStarted becomes a patch with a running
//     Turn + TurnLifecycle, and
//  2. the terminal fact is ONLY a RootProviderTurn{phase: completed} patch —
//     no settled Turn, no settled TurnLifecycle. The canonical settlement
//     (workspace_agent_turns → settled/completed) happens inside the store's
//     root-provider aggregation.
//
// The on_task_complete automation rule must fire from that canonical
// settlement. Before the projection fanned the committed root-turn settlement
// out to the session-state observers this test deadlocked on the executor
// channel: ObserveAgentSessionState only ever saw the RootProviderTurn patch,
// which carries no settled TurnLifecycle/Turn state.
func TestAutomationRuleFiresFromLiveRootProviderTurnSettlement(t *testing.T) {
	ctx := context.Background()
	store, err := workspacedata.OpenSQLiteStore(filepath.Join(t.TempDir(), "tutti.sqlite"))
	if err != nil {
		t.Fatalf("OpenSQLiteStore() error = %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("Migrate() error = %v", err)
	}
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws", Name: "Workspace"}); err != nil {
		t.Fatalf("Create(workspace) error = %v", err)
	}

	rules := newMemoryStore()
	if err := rules.CreateAutomationRule(ctx, launchRule(t, "rule-complete", automationrulebiz.TriggerOnTaskComplete, "local:claude-code")); err != nil {
		t.Fatalf("CreateAutomationRule() error = %v", err)
	}
	calls := make(chan ExecutionInput, 1)
	automation := &Service{Store: rules, Executor: recordingExecutor{calls: calls}, Usage: staticUsage{}}

	projection := agentservice.NewActivityProjection(store)
	projection.SetRootTurnSettleStateObserver(automation)

	const (
		workspaceID = "ws"
		sessionID   = "session-live-codex"
		turnID      = "turn-live-1"
	)
	activeTurnID := turnID

	// Live shape 1: adapter-stamped turn start (running Turn + TurnLifecycle).
	if _, err := projection.ReportSessionState(ctx, canonical.ReportSessionStateInput{
		WorkspaceID:    workspaceID,
		AgentSessionID: sessionID,
		SessionOrigin:  agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		State: canonical.WorkspaceAgentSessionStateUpdate{
			Provider:     "codex",
			CurrentPhase: "working",
			Turn: &canonical.WorkspaceAgentTurnStateUpdate{
				TurnID:          turnID,
				ActiveTurnID:    &activeTurnID,
				Phase:           "running",
				StartedAtUnixMS: 1_700_000_000_000,
			},
			TurnLifecycle: &canonical.WorkspaceAgentTurnLifecycle{
				ActiveTurnID: &activeTurnID,
				Phase:        "running",
			},
			OccurredAtUnixMS: 1_700_000_000_000,
		},
	}); err != nil {
		t.Fatalf("ReportSessionState(turn started) error = %v", err)
	}

	// Live shape 2: the codex terminal patch — RootProviderTurn only. The
	// settled Turn/TurnLifecycle never appears in any reported state; the
	// canonical settlement is the store's own root-provider aggregation.
	if _, err := projection.ReportSessionState(ctx, canonical.ReportSessionStateInput{
		WorkspaceID:    workspaceID,
		AgentSessionID: sessionID,
		SessionOrigin:  agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		State: canonical.WorkspaceAgentSessionStateUpdate{
			Provider: "codex",
			RootProviderTurn: &canonical.WorkspaceAgentRootProviderTurnTransition{
				RootTurnID:     turnID,
				ProviderTurnID: "provider-turn-1",
				Phase:          canonical.RootProviderTurnPhaseCompleted,
				Outcome:        "completed",
			},
			OccurredAtUnixMS: 1_700_000_010_000,
		},
	}); err != nil {
		t.Fatalf("ReportSessionState(root provider completed) error = %v", err)
	}

	select {
	case call := <-calls:
		if call.Rule.ID != "rule-complete" || call.WorkspaceID != workspaceID ||
			call.SourceSessionID != sessionID || call.TriggerID != turnID {
			t.Fatalf("execution call = %#v", call)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("automation rule did not fire from the live root-provider turn settlement")
	}
}

// TestAutomationRuleFiresOnceFromCancelRuntimeOperationSettlement exercises
// the cancel funnel (RuntimeOperationEventTurnCanceled), whose settle
// observation reads the committed turn back via GetTurn instead of using a
// transition result. A turn settled with outcome=interrupted must fire the
// on_task_failed rule (and never on_task_complete), and a second delivery of
// the same settlement — the at-least-once overlap an AlreadySettled cancel or
// an outbox publish retry produces — must not execute the rule again.
func TestAutomationRuleFiresOnceFromCancelRuntimeOperationSettlement(t *testing.T) {
	ctx := context.Background()
	store, err := workspacedata.OpenSQLiteStore(filepath.Join(t.TempDir(), "tutti.sqlite"))
	if err != nil {
		t.Fatalf("OpenSQLiteStore() error = %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("Migrate() error = %v", err)
	}
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws", Name: "Workspace"}); err != nil {
		t.Fatalf("Create(workspace) error = %v", err)
	}

	rules := newMemoryStore()
	if err := rules.CreateAutomationRule(ctx, launchRule(t, "rule-complete", automationrulebiz.TriggerOnTaskComplete, "local:claude-code")); err != nil {
		t.Fatalf("CreateAutomationRule(complete) error = %v", err)
	}
	if err := rules.CreateAutomationRule(ctx, launchRule(t, "rule-rescue", automationrulebiz.TriggerOnTaskFailed, "local:claude-code")); err != nil {
		t.Fatalf("CreateAutomationRule(rescue) error = %v", err)
	}
	calls := make(chan ExecutionInput, 2)
	automation := &Service{Store: rules, Executor: recordingExecutor{calls: calls}, Usage: staticUsage{}}

	projection := agentservice.NewActivityProjection(store)
	projection.SetPublisher(noopActivityPublisher{})
	projection.SetRootTurnSettleStateObserver(automation)

	const (
		workspaceID = "ws"
		sessionID   = "session-canceled"
		turnID      = "turn-canceled-1"
	)
	activeTurnID := turnID
	if _, err := projection.ReportSessionState(ctx, canonical.ReportSessionStateInput{
		WorkspaceID:    workspaceID,
		AgentSessionID: sessionID,
		SessionOrigin:  agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		State: canonical.WorkspaceAgentSessionStateUpdate{
			Provider:     "codex",
			CurrentPhase: "working",
			Turn: &canonical.WorkspaceAgentTurnStateUpdate{
				TurnID:          turnID,
				ActiveTurnID:    &activeTurnID,
				Phase:           "running",
				StartedAtUnixMS: 1_700_000_000_000,
			},
			TurnLifecycle: &canonical.WorkspaceAgentTurnLifecycle{
				ActiveTurnID: &activeTurnID,
				Phase:        "running",
			},
			OccurredAtUnixMS: 1_700_000_000_000,
		},
	}); err != nil {
		t.Fatalf("ReportSessionState(turn started) error = %v", err)
	}

	// Settle the running turn out of band at the repo layer (interrupted),
	// mirroring the cancel runtime operation's store-side settlement: the
	// projection observes nothing here, so the cancel funnel below is the
	// only settle delivery.
	settlements, err := store.SettleStaleTurns(ctx)
	if err != nil {
		t.Fatalf("SettleStaleTurns() error = %v", err)
	}
	if len(settlements) != 1 || settlements[0].TurnID != turnID {
		t.Fatalf("settlements = %#v, want the running turn settled", settlements)
	}

	canceledEvent := agentactivitybiz.RuntimeOperationEvent{
		Kind:           agentactivitybiz.RuntimeOperationEventTurnCanceled,
		WorkspaceID:    workspaceID,
		AgentSessionID: sessionID,
		Payload: map[string]any{
			"rootAgentSessionId": sessionID,
			"targets": []any{
				map[string]any{"agentSessionId": sessionID, "turnId": turnID},
			},
		},
		CreatedAtUnixMS: 1_700_000_020_000,
	}
	if err := projection.PublishRuntimeOperationEvent(ctx, canceledEvent); err != nil {
		t.Fatalf("PublishRuntimeOperationEvent() error = %v", err)
	}

	select {
	case call := <-calls:
		if call.Rule.ID != "rule-rescue" || call.Rule.Trigger != automationrulebiz.TriggerOnTaskFailed ||
			call.SourceSessionID != sessionID || call.TriggerID != turnID {
			t.Fatalf("execution call = %#v, want the on_task_failed rule", call)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("cancel settlement did not fire the on_task_failed rule")
	}

	// Second delivery of the same settlement (AlreadySettled overlap / outbox
	// publish retry): at-least-once delivery must stay execute-once.
	if err := projection.PublishRuntimeOperationEvent(ctx, canceledEvent); err != nil {
		t.Fatalf("PublishRuntimeOperationEvent(retry) error = %v", err)
	}
	select {
	case duplicate := <-calls:
		t.Fatalf("duplicate settle delivery re-executed automation: %#v", duplicate)
	case <-time.After(100 * time.Millisecond):
	}
}

// TestObserveAgentSessionStateIgnoresChildSessionSettledState pins that child
// sessions (codex collab threads report their own settled turns through the
// same state pipeline) never evaluate automation rules; the root session's
// canonical settlement is the only automation trigger source.
func TestObserveAgentSessionStateIgnoresChildSessionSettledState(t *testing.T) {
	store := newMemoryStore()
	if err := store.CreateAutomationRule(context.Background(), launchRule(t, "rule-1", automationrulebiz.TriggerOnTaskComplete, "workspace-agent:target")); err != nil {
		t.Fatalf("CreateAutomationRule() error = %v", err)
	}
	calls := make(chan ExecutionInput, 1)
	service := &Service{Store: store, Executor: recordingExecutor{calls: calls}, Usage: staticUsage{}}
	outcome, turnID := "completed", "child-turn-1"
	service.ObserveAgentSessionState(context.Background(), canonical.ReportSessionStateInput{
		WorkspaceID:    "ws",
		AgentSessionID: "child-session-1",
		State: canonical.WorkspaceAgentSessionStateUpdate{
			Kind:                 "child",
			ParentAgentSessionID: "session-root",
			TurnLifecycle:        &canonical.WorkspaceAgentTurnLifecycle{Phase: "settled", Outcome: &outcome},
			Turn: &canonical.WorkspaceAgentTurnStateUpdate{
				TurnID:  turnID,
				Phase:   "settled",
				Outcome: outcome,
			},
		},
	}, canonical.ReportSessionStateReply{})
	select {
	case call := <-calls:
		t.Fatalf("child session settled state fired automation rule: %#v", call)
	case <-time.After(50 * time.Millisecond):
	}
}
