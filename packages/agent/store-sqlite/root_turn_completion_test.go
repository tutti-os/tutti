package storesqlite

import (
	"context"
	"encoding/json"
	"testing"
)

func TestHistoricalDuplicateProviderBindingCanStillAdvance(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID: "ws-1", AgentSessionID: "source", Kind: SessionKindRoot,
		Origin: "runtime", Provider: "codex", ProviderSessionID: "provider-source",
		Status: "ready", CurrentPhase: "idle", OccurredAtUnixMS: 1,
	}); err != nil {
		t.Fatal(err)
	}
	for index, turnID := range []string{"turn-1", "turn-2"} {
		occurred := int64(10 + index*10)
		providerTurnID := "provider-" + turnID
		if _, err := store.ReportActivityState(ctx, ActivityStateReport{
			Session: SessionStateReport{
				WorkspaceID: "ws-1", AgentSessionID: "source", Kind: SessionKindRoot,
				Origin: "runtime", Provider: "codex", ProviderSessionID: "provider-source",
				Status: "active", CurrentPhase: "working", OccurredAtUnixMS: occurred,
			},
			Turn: &TurnTransition{
				WorkspaceID: "ws-1", AgentSessionID: "source", TurnID: turnID,
				Phase: TurnPhaseRunning, OccurredAtUnixMS: occurred,
			},
			RootProviderTurn: &RootProviderTurnTransition{
				WorkspaceID: "ws-1", RootAgentSessionID: "source", RootTurnID: turnID,
				ProviderTurnID: providerTurnID, Phase: RootProviderTurnPhaseRunning,
				OccurredAtUnixMS: occurred,
			},
		}); err != nil {
			t.Fatal(err)
		}
		if turnID == "turn-1" {
			reportRootProviderTurn(
				t,
				store,
				"source",
				turnID,
				providerTurnID,
				RootProviderTurnPhaseCompleted,
				occurred+1,
			)
		}
	}
	if _, err := store.db.ExecContext(ctx, `
UPDATE workspace_agent_turns
SET root_provider_turn_id = 'provider-turn-1'
WHERE workspace_id = 'ws-1' AND agent_session_id = 'source' AND turn_id = 'turn-2'
`); err != nil {
		t.Fatal(err)
	}

	result, err := store.ReportActivityState(ctx, ActivityStateReport{
		Session: SessionStateReport{
			WorkspaceID: "ws-1", AgentSessionID: "source",
			OccurredAtUnixMS: 100,
		},
		RootProviderTurn: &RootProviderTurnTransition{
			WorkspaceID: "ws-1", RootAgentSessionID: "source",
			RootTurnID: "turn-2", ProviderTurnID: "provider-turn-1",
			Phase: RootProviderTurnPhaseCompleted, Outcome: TurnOutcomeCompleted,
			OccurredAtUnixMS: 100,
		},
	})
	if err != nil {
		t.Fatalf("advance historical duplicate binding: %v", err)
	}
	if result.RootTurn.RootProviderTurnID != "provider-turn-1" ||
		result.RootTurn.RootProviderTurnPhase != RootProviderTurnPhaseCompleted ||
		result.RootTurn.Phase != TurnPhaseSettled {
		t.Fatalf("advanced historical turn = %#v", result.RootTurn)
	}
}

func TestProviderCheckpointPersistsThroughAndAfterTurnSettlement(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	reportSessionWithTurn(t, store, SessionStateReport{
		WorkspaceID: "ws-1", AgentSessionID: "root",
		Provider: "claude-code", OccurredAtUnixMS: 10,
	}, "turn-1", 10)
	reportRootProviderTurn(
		t,
		store,
		"root",
		"turn-1",
		"provider-user-1",
		RootProviderTurnPhaseRunning,
		11,
	)
	for _, checkpoint := range []struct {
		id       string
		occurred int64
	}{
		{id: "provider-assistant-1", occurred: 12},
		{id: "provider-system-1", occurred: 14},
	} {
		if checkpoint.occurred == 14 {
			reportRootProviderTurn(
				t,
				store,
				"root",
				"turn-1",
				"provider-user-1",
				RootProviderTurnPhaseCompleted,
				13,
			)
		}
		if _, err := store.ReportActivityState(ctx, ActivityStateReport{
			Session: SessionStateReport{
				WorkspaceID: "ws-1", AgentSessionID: "root",
				OccurredAtUnixMS: checkpoint.occurred,
			},
			RootProviderTurn: &RootProviderTurnTransition{
				WorkspaceID: "ws-1", RootAgentSessionID: "root",
				RootTurnID: "turn-1", ProviderTurnID: "provider-user-1",
				ProviderTurnBindingJSON: json.RawMessage(
					`{"checkpointMessageId":"` + checkpoint.id + `"}`,
				),
				OccurredAtUnixMS: checkpoint.occurred,
			},
		}); err != nil {
			t.Fatalf("persist checkpoint %q: %v", checkpoint.id, err)
		}
	}
	if _, err := store.ReportActivityState(ctx, ActivityStateReport{
		Session: SessionStateReport{
			WorkspaceID: "ws-1", AgentSessionID: "root",
			OccurredAtUnixMS: 12,
		},
		RootProviderTurn: &RootProviderTurnTransition{
			WorkspaceID: "ws-1", RootAgentSessionID: "root",
			RootTurnID: "turn-1", ProviderTurnID: "provider-user-1",
			ProviderTurnBindingJSON: json.RawMessage(
				`{"checkpointMessageId":"provider-assistant-stale"}`,
			),
			OccurredAtUnixMS: 12,
		},
	}); err != nil {
		t.Fatalf("persist stale checkpoint: %v", err)
	}
	turn, found, err := store.GetTurn(ctx, "ws-1", "root", "turn-1")
	if err != nil || !found ||
		string(turn.ProviderTurnBindingJSON) !=
			`{"checkpointMessageId":"provider-system-1"}` ||
		turn.RootProviderTurnUpdatedAtUnixMS != 14 {
		t.Fatalf("persisted turn=%#v found=%v error=%v", turn, found, err)
	}
}

func TestProviderTurnBindingJSONDoesNotSurviveIdentityReplacement(
	t *testing.T,
) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	reportSessionWithTurn(t, store, SessionStateReport{
		WorkspaceID: "ws-1", AgentSessionID: "root",
		Provider: "claude-code", OccurredAtUnixMS: 10,
	}, "turn-1", 10)
	if _, err := store.ReportActivityState(ctx, ActivityStateReport{
		Session: SessionStateReport{
			WorkspaceID: "ws-1", AgentSessionID: "root",
			OccurredAtUnixMS: 11,
		},
		RootProviderTurn: &RootProviderTurnTransition{
			WorkspaceID: "ws-1", RootAgentSessionID: "root",
			RootTurnID: "turn-1", ProviderTurnID: "provider-observed",
			ProviderTurnBindingJSON: json.RawMessage(
				`{"checkpointMessageId":"checkpoint-observed"}`,
			),
			Phase:            RootProviderTurnPhaseRunning,
			OccurredAtUnixMS: 11,
		},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReportActivityState(ctx, ActivityStateReport{
		Session: SessionStateReport{
			WorkspaceID: "ws-1", AgentSessionID: "root",
			OccurredAtUnixMS: 12,
		},
		RootProviderTurn: &RootProviderTurnTransition{
			WorkspaceID: "ws-1", RootAgentSessionID: "root",
			RootTurnID: "turn-1", ProviderTurnID: "synthetic-replacement",
			Phase: RootProviderTurnPhaseRunning, OccurredAtUnixMS: 12,
		},
	}); err != nil {
		t.Fatal(err)
	}
	turn, found, err := store.GetTurn(ctx, "ws-1", "root", "turn-1")
	if err != nil || !found {
		t.Fatalf("GetTurn() found=%v error=%v", found, err)
	}
	if turn.RootProviderTurnID != "synthetic-replacement" ||
		string(turn.ProviderTurnBindingJSON) != "{}" ||
		HasPersistedProviderTurnBinding(turn) {
		t.Fatalf("replacement inherited stale provider evidence: %#v", turn)
	}
}

func TestReportActivityStateAtomicallyCreatesGoalTurnAndProviderBinding(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID: "ws-1", AgentSessionID: "root", Kind: SessionKindRoot,
		Provider: "claude-code", OccurredAtUnixMS: 20,
	}); err != nil {
		t.Fatalf("seed newer session snapshot: %v", err)
	}

	result, err := store.ReportActivityState(ctx, ActivityStateReport{
		Session: SessionStateReport{
			WorkspaceID: "ws-1", AgentSessionID: "root", Kind: SessionKindRoot,
			Provider: "claude-code", OccurredAtUnixMS: 10,
		},
		Turn: &TurnTransition{
			WorkspaceID: "ws-1", AgentSessionID: "root", TurnID: "goal-turn",
			Phase: TurnPhaseRunning, Origin: TurnOriginGoalArm,
			SourceGoalOperationID: "goal-op-1", SourceGoalRevision: 1,
			OccurredAtUnixMS: 10,
		},
		RootProviderTurn: &RootProviderTurnTransition{
			WorkspaceID: "ws-1", RootAgentSessionID: "root", RootTurnID: "goal-turn",
			ProviderTurnID: "provider-turn", Phase: RootProviderTurnPhaseRunning,
			OccurredAtUnixMS: 10,
		},
	})
	if err != nil {
		t.Fatalf("ReportActivityState(goal provider start): %v", err)
	}
	if !result.TurnAccepted || !result.RootTurnAccepted {
		t.Fatalf("compound goal start result = %#v", result)
	}
	if result.State.StateApplied {
		t.Fatalf("stale enclosing session unexpectedly applied: %#v", result.State)
	}
	turn, found, err := store.GetTurn(ctx, "ws-1", "root", "goal-turn")
	if err != nil || !found || turn.Origin != TurnOriginGoalArm || turn.SourceGoalOperationID != "goal-op-1" ||
		turn.RootProviderTurnID != "provider-turn" || turn.RootProviderTurnPhase != RootProviderTurnPhaseRunning {
		t.Fatalf("persisted compound goal turn = %#v found=%v err=%v", turn, found, err)
	}
	messageResult, err := store.ReportSessionMessages(ctx, SessionMessageReport{
		WorkspaceID: "ws-1", AgentSessionID: "root", Origin: "runtime",
		Messages: []MessageUpdate{{
			MessageID: "assistant-1", TurnID: "goal-turn", Role: "assistant",
			Kind: "text", Status: "running", Payload: map[string]any{"text": "working"},
			OccurredAtUnixMS: 11,
		}},
	})
	if err != nil || messageResult.AcceptedCount != 1 {
		t.Fatalf("persist first goal assistant message = %#v err=%v", messageResult, err)
	}
	completed, err := store.ReportActivityState(ctx, ActivityStateReport{
		Session: SessionStateReport{
			WorkspaceID: "ws-1", AgentSessionID: "root", OccurredAtUnixMS: 30,
		},
		RootProviderTurn: &RootProviderTurnTransition{
			WorkspaceID: "ws-1", RootAgentSessionID: "root", RootTurnID: "goal-turn",
			ProviderTurnID: "provider-turn", Phase: RootProviderTurnPhaseCompleted,
			Outcome: TurnOutcomeCompleted, OccurredAtUnixMS: 30,
		},
	})
	if err != nil || !completed.RootTurnAccepted || completed.RootTurn.Phase != TurnPhaseSettled {
		t.Fatalf("settle compound goal turn = %#v err=%v", completed, err)
	}
	settledSession, found, err := store.GetSession(ctx, "ws-1", "root")
	if err != nil || !found || settledSession.ActiveTurnID != "" {
		t.Fatalf("settled compound goal session = %#v found=%v err=%v", settledSession, found, err)
	}
}

func TestReportActivityStateRollsBackGoalTurnWhenProviderBindingFails(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()

	_, err := store.ReportActivityState(ctx, ActivityStateReport{
		Session: SessionStateReport{
			WorkspaceID: "ws-1", AgentSessionID: "root", Kind: SessionKindRoot,
			Provider: "claude-code", OccurredAtUnixMS: 10,
		},
		Turn: &TurnTransition{
			WorkspaceID: "ws-1", AgentSessionID: "root", TurnID: "goal-turn",
			Phase: TurnPhaseRunning, Origin: TurnOriginGoalArm,
			SourceGoalOperationID: "goal-op-1", SourceGoalRevision: 1,
			OccurredAtUnixMS: 10,
		},
		RootProviderTurn: &RootProviderTurnTransition{
			WorkspaceID: "ws-1", RootAgentSessionID: "root", RootTurnID: "missing-turn",
			ProviderTurnID: "provider-turn", Phase: RootProviderTurnPhaseRunning,
			OccurredAtUnixMS: 10,
		},
	})
	if err == nil {
		t.Fatal("compound report with invalid provider binding unexpectedly succeeded")
	}
	if turn, found, getErr := store.GetTurn(ctx, "ws-1", "root", "goal-turn"); getErr != nil || found {
		t.Fatalf("failed compound report leaked canonical turn = %#v found=%v err=%v", turn, found, getErr)
	}
}

func TestRootProviderCompletionWaitsForEveryChildTurn(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	reportSessionWithTurn(t, store, SessionStateReport{
		WorkspaceID: "ws-1", AgentSessionID: "root", Provider: "codex", OccurredAtUnixMS: 10,
	}, "root-turn", 10)
	reportSessionWithTurn(t, store, SessionStateReport{
		WorkspaceID: "ws-1", AgentSessionID: "child", Kind: SessionKindChild,
		RootAgentSessionID: "root", RootTurnID: "root-turn",
		ParentAgentSessionID: "root", ParentTurnID: "root-turn", ParentToolCallID: "call-1",
		Provider: "codex", OccurredAtUnixMS: 20,
	}, "child-turn", 20)

	completed := reportRootProviderTurn(t, store, "root", "root-turn", "provider-turn-1", RootProviderTurnPhaseCompleted, 30)
	if !completed.RootTurnAccepted || completed.RootTurn.Phase != TurnPhaseWaiting {
		t.Fatalf("root provider completion result = %#v", completed)
	}
	persistedRoot, ok, err := store.GetTurn(ctx, "ws-1", "root", "root-turn")
	if err != nil || !ok || persistedRoot.Phase != TurnPhaseWaiting ||
		persistedRoot.RootProviderTurnPhase != RootProviderTurnPhaseCompleted {
		t.Fatalf("persisted root after provider completion = %#v ok=%v err=%v", persistedRoot, ok, err)
	}

	childResult, err := store.ReportActivityState(ctx, ActivityStateReport{
		Session: SessionStateReport{
			WorkspaceID: "ws-1", AgentSessionID: "child", OccurredAtUnixMS: 40,
		},
		Turn: &TurnTransition{
			WorkspaceID: "ws-1", AgentSessionID: "child", TurnID: "child-turn",
			Phase: TurnPhaseSettled, Outcome: TurnOutcomeFailed, OccurredAtUnixMS: 40,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !childResult.TurnAccepted || childResult.Turn.Outcome != TurnOutcomeFailed ||
		!childResult.RootTurnAccepted || childResult.RootTurn.Phase != TurnPhaseSettled ||
		childResult.RootTurn.Outcome != TurnOutcomeCompleted {
		t.Fatalf("child terminal result = %#v", childResult)
	}
}

func TestLateRootProviderCompletionUpdatesProjectionWithoutChangingCanceledCanonicalTurn(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	reportSessionWithTurn(t, store, SessionStateReport{
		WorkspaceID: "ws-1", AgentSessionID: "root", Kind: SessionKindRoot,
		Provider: "codex", OccurredAtUnixMS: 10,
	}, "root-turn", 10)
	reportRootProviderTurn(t, store, "root", "root-turn", "provider-turn-1", RootProviderTurnPhaseRunning, 20)

	if _, created, err := store.PrepareRuntimeOperation(ctx, RuntimeOperationPrepare{
		OperationID: "cancel-root", WorkspaceID: "ws-1", AgentSessionID: "root",
		Kind: RuntimeOperationKindCancelTurn, TurnID: "root-turn", OccurredAtMS: 20,
		Payload: map[string]any{"rootAgentSessionId": "root", "targets": []any{
			map[string]any{"agentSessionId": "root", "turnId": "root-turn"},
		}},
	}); err != nil || !created {
		t.Fatalf("prepare cancel created=%v err=%v", created, err)
	}
	claimRuntimeOperation(t, store, "cancel-root", "worker-a")
	if _, changed, err := store.CompleteCancelRuntimeOperation(ctx, CompleteCancelRuntimeOperationInput{
		WorkspaceID: "ws-1", OperationID: "cancel-root", LeaseOwner: "worker-a",
		TargetOutcomes: []CancelRuntimeOperationTargetOutcome{{
			AgentSessionID: "root", TurnID: "root-turn", Outcome: TurnOutcomeCanceled,
		}},
		NowUnixMS: 30,
	}); err != nil || !changed {
		t.Fatalf("complete cancel changed=%v err=%v", changed, err)
	}
	lateStarted, err := store.ReportActivityState(ctx, ActivityStateReport{
		Session: SessionStateReport{
			WorkspaceID: "ws-1", AgentSessionID: "root", Kind: SessionKindRoot,
			Provider: "codex", OccurredAtUnixMS: 35,
		},
		RootProviderTurn: &RootProviderTurnTransition{
			WorkspaceID: "ws-1", RootAgentSessionID: "root", RootTurnID: "root-turn",
			ProviderTurnID: "provider-turn-2", Phase: RootProviderTurnPhaseRunning,
			OccurredAtUnixMS: 35,
		},
	})
	if err != nil || lateStarted.RootTurnAccepted || lateStarted.RootTurn.Phase != TurnPhaseSettled ||
		lateStarted.RootTurn.RootProviderTurnID != "provider-turn-1" {
		t.Fatalf("late provider start = %#v error=%v, want settled root unchanged", lateStarted, err)
	}
	if _, err := store.ReportActivityState(ctx, ActivityStateReport{
		Session: SessionStateReport{
			WorkspaceID: "ws-1", AgentSessionID: "root", Kind: SessionKindRoot,
			Provider: "codex", OccurredAtUnixMS: 40,
		},
		Turn: &TurnTransition{
			WorkspaceID: "ws-1", AgentSessionID: "root", TurnID: "root-turn",
			Phase: TurnPhaseRunning, OccurredAtUnixMS: 40,
		},
		RootProviderTurn: &RootProviderTurnTransition{
			WorkspaceID: "ws-1", RootAgentSessionID: "root", RootTurnID: "root-turn",
			ProviderTurnID: "provider-turn-1", Phase: RootProviderTurnPhaseCompleted,
			Outcome: TurnOutcomeCanceled, OccurredAtUnixMS: 40,
		},
	}); err == nil {
		t.Fatal("mixed provider terminal and canonical running transition unexpectedly succeeded")
	}
	beforeTerminal, found, err := store.GetTurn(ctx, "ws-1", "root", "root-turn")
	if err != nil || !found || beforeTerminal.RootProviderTurnPhase != RootProviderTurnPhaseRunning {
		t.Fatalf("rejected mixed report changed provider projection: %#v found=%v err=%v", beforeTerminal, found, err)
	}

	result, err := store.ReportActivityState(ctx, ActivityStateReport{
		Session: SessionStateReport{
			WorkspaceID: "ws-1", AgentSessionID: "root", Kind: SessionKindRoot,
			Provider: "codex", OccurredAtUnixMS: 50,
		},
		RootProviderTurn: &RootProviderTurnTransition{
			WorkspaceID: "ws-1", RootAgentSessionID: "root", RootTurnID: "root-turn",
			ProviderTurnID: "provider-turn-1", Phase: RootProviderTurnPhaseCompleted,
			Outcome: TurnOutcomeCanceled, OccurredAtUnixMS: 50,
		},
	})
	if err != nil {
		t.Fatalf("report late provider completion: %v", err)
	}
	if result.TurnAccepted || result.RootTurnAccepted || !result.RootProviderTurnAccepted {
		t.Fatalf("late provider completion changed canonical turn: %#v", result)
	}
	providerMutationCommitted := false
	for _, mutation := range result.CommitDelta.Mutations {
		if mutation.EntityKind == MutationEntityTurn && mutation.EntityID == "root-turn" {
			providerMutationCommitted = true
			break
		}
	}
	if !providerMutationCommitted {
		t.Fatalf("late provider completion has no root turn mutation: %#v", result.CommitDelta)
	}
	turn, found, err := store.GetTurn(ctx, "ws-1", "root", "root-turn")
	if err != nil || !found {
		t.Fatalf("get root turn found=%v err=%v", found, err)
	}
	if turn.Phase != TurnPhaseSettled || turn.Outcome != TurnOutcomeCanceled {
		t.Fatalf("canonical root turn = %#v, want settled/canceled", turn)
	}
	if turn.RootProviderTurnPhase != RootProviderTurnPhaseCompleted ||
		turn.RootProviderTurnOutcome != TurnOutcomeCanceled {
		t.Fatalf("provider projection = %#v, want completed/canceled", turn)
	}
}

func TestClaudeGoalCompleteDoesNotSettleRootWhileChildRuns(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	reportSessionWithTurn(t, store, SessionStateReport{
		WorkspaceID: "ws-1", AgentSessionID: "root", Provider: "claude-code", OccurredAtUnixMS: 10,
		RuntimeContext: map[string]any{
			"goal": map[string]any{"objective": "ship it", "status": "active"},
		},
	}, "root-turn", 10)
	reportSessionWithTurn(t, store, SessionStateReport{
		WorkspaceID: "ws-1", AgentSessionID: "child", Kind: SessionKindChild,
		RootAgentSessionID: "root", RootTurnID: "root-turn",
		ParentAgentSessionID: "root", ParentTurnID: "root-turn", ParentToolCallID: "toolu-1",
		Provider: "claude-code", OccurredAtUnixMS: 20,
	}, "child-turn", 20)

	providerCompleted, err := store.ReportActivityState(ctx, ActivityStateReport{
		Session: SessionStateReport{
			WorkspaceID: "ws-1", AgentSessionID: "root", OccurredAtUnixMS: 30,
			RuntimeContext: map[string]any{
				"goal": map[string]any{"objective": "ship it", "status": "complete"},
			},
		},
		RootProviderTurn: &RootProviderTurnTransition{
			WorkspaceID: "ws-1", RootAgentSessionID: "root", RootTurnID: "root-turn",
			ProviderTurnID: "claude-turn-1", Phase: RootProviderTurnPhaseCompleted,
			Outcome: TurnOutcomeCompleted, OccurredAtUnixMS: 30,
		},
	})
	if err != nil || !providerCompleted.RootTurnAccepted || providerCompleted.RootTurn.Phase != TurnPhaseWaiting {
		t.Fatalf("goal/provider completion result = %#v err=%v", providerCompleted, err)
	}
	persistedRootSession, ok, err := store.GetSession(ctx, "ws-1", "root")
	if err != nil || !ok || persistedRootSession.ActiveTurnID != "root-turn" ||
		persistedRootSession.Metadata.Goal == nil || persistedRootSession.Metadata.Goal.Status != "complete" {
		t.Fatalf("persisted root session = %#v ok=%v err=%v", persistedRootSession, ok, err)
	}
	persistedRootTurn, ok, err := store.GetTurn(ctx, "ws-1", "root", "root-turn")
	if err != nil || !ok || persistedRootTurn.Phase != TurnPhaseWaiting ||
		persistedRootTurn.RootProviderTurnPhase != RootProviderTurnPhaseCompleted {
		t.Fatalf("persisted root turn = %#v ok=%v err=%v", persistedRootTurn, ok, err)
	}
	persistedChildSession, ok, err := store.GetSession(ctx, "ws-1", "child")
	if err != nil || !ok || persistedChildSession.ActiveTurnID != "child-turn" {
		t.Fatalf("persisted child session = %#v ok=%v err=%v", persistedChildSession, ok, err)
	}

	childTerminal, err := store.ReportActivityState(ctx, ActivityStateReport{
		Session: SessionStateReport{
			WorkspaceID: "ws-1", AgentSessionID: "child", OccurredAtUnixMS: 40,
		},
		Turn: &TurnTransition{
			WorkspaceID: "ws-1", AgentSessionID: "child", TurnID: "child-turn",
			Phase: TurnPhaseSettled, Outcome: TurnOutcomeCompleted, OccurredAtUnixMS: 40,
		},
	})
	if err != nil || !childTerminal.RootTurnAccepted ||
		childTerminal.RootTurn.Phase != TurnPhaseSettled ||
		childTerminal.RootTurn.Outcome != TurnOutcomeCompleted {
		t.Fatalf("child-only terminal result = %#v err=%v", childTerminal, err)
	}
	settledRootSession, ok, err := store.GetSession(ctx, "ws-1", "root")
	if err != nil || !ok || settledRootSession.ActiveTurnID != "" ||
		settledRootSession.Metadata.Goal == nil || settledRootSession.Metadata.Goal.Status != "complete" {
		t.Fatalf("settled root session = %#v ok=%v err=%v", settledRootSession, ok, err)
	}
}

func TestRootProviderCompletionIsOrderIndependentAndTracksLatestProviderTurn(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	reportSessionWithTurn(t, store, SessionStateReport{
		WorkspaceID: "ws-1", AgentSessionID: "root", Provider: "claude-code", OccurredAtUnixMS: 10,
	}, "root-turn", 10)
	reportSessionWithTurn(t, store, SessionStateReport{
		WorkspaceID: "ws-1", AgentSessionID: "child", Kind: SessionKindChild,
		RootAgentSessionID: "root", RootTurnID: "root-turn",
		ParentAgentSessionID: "root", ParentTurnID: "root-turn", ParentToolCallID: "toolu-1",
		Provider: "claude-code", OccurredAtUnixMS: 20,
	}, "child-turn", 20)

	firstCompleted := reportRootProviderTurn(t, store, "root", "root-turn", "provider-turn-1", RootProviderTurnPhaseCompleted, 30)
	if firstCompleted.RootTurn.Phase != TurnPhaseWaiting {
		t.Fatalf("first provider completion = %#v", firstCompleted)
	}
	started := reportRootProviderTurn(t, store, "root", "root-turn", "provider-turn-2", RootProviderTurnPhaseRunning, 40)
	if !started.RootTurnAccepted || started.RootTurn.Phase != TurnPhaseRunning ||
		started.RootTurn.RootProviderTurnID != "provider-turn-2" {
		t.Fatalf("second provider start = %#v", started)
	}

	childResult, err := store.ReportActivityState(ctx, ActivityStateReport{
		Session: SessionStateReport{WorkspaceID: "ws-1", AgentSessionID: "child", OccurredAtUnixMS: 50},
		Turn: &TurnTransition{
			WorkspaceID: "ws-1", AgentSessionID: "child", TurnID: "child-turn",
			Phase: TurnPhaseSettled, Outcome: TurnOutcomeCompleted, OccurredAtUnixMS: 50,
		},
	})
	if err != nil || childResult.RootTurnAccepted {
		t.Fatalf("child completion while latest provider turn runs = %#v err=%v", childResult, err)
	}
	root, ok, err := store.GetTurn(ctx, "ws-1", "root", "root-turn")
	if err != nil || !ok || root.Phase != TurnPhaseRunning {
		t.Fatalf("root before latest provider completion = %#v ok=%v err=%v", root, ok, err)
	}

	final := reportRootProviderTurn(t, store, "root", "root-turn", "provider-turn-2", RootProviderTurnPhaseCompleted, 60)
	if !final.RootTurnAccepted || final.RootTurn.Phase != TurnPhaseSettled || final.RootTurn.Outcome != TurnOutcomeCompleted {
		t.Fatalf("final provider completion = %#v", final)
	}
}

func TestGuidanceContinuationFencesInterruptedProviderTerminal(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	reportSessionWithTurn(t, store, SessionStateReport{
		WorkspaceID: "ws-1", AgentSessionID: "root", Kind: SessionKindRoot,
		Provider: "codex", OccurredAtUnixMS: 10,
	}, "root-turn", 10)
	reportRootProviderTurn(t, store, "root", "root-turn", "provider-old", RootProviderTurnPhaseRunning, 20)
	reportRootProviderTurn(t, store, "root", "root-turn", "continuation:guidance", RootProviderTurnPhaseRunning, 30)

	if _, err := store.ReportActivityState(ctx, ActivityStateReport{
		Session: SessionStateReport{
			WorkspaceID: "ws-1", AgentSessionID: "root", Kind: SessionKindRoot,
			Provider: "codex", OccurredAtUnixMS: 40,
		},
		RootProviderTurn: &RootProviderTurnTransition{
			WorkspaceID: "ws-1", RootAgentSessionID: "root", RootTurnID: "root-turn",
			ProviderTurnID: "provider-old", Phase: RootProviderTurnPhaseCompleted,
			Outcome: TurnOutcomeCanceled, OccurredAtUnixMS: 40,
		},
	}); err != nil {
		t.Fatal(err)
	}
	root, found, err := store.GetTurn(ctx, "ws-1", "root", "root-turn")
	if err != nil || !found || root.Phase != TurnPhaseRunning ||
		root.RootProviderTurnID != "continuation:guidance" ||
		root.RootProviderTurnPhase != RootProviderTurnPhaseRunning {
		t.Fatalf("interrupted response settled guidance root: %#v found=%v err=%v", root, found, err)
	}

	reportRootProviderTurn(t, store, "root", "root-turn", "provider-guidance", RootProviderTurnPhaseRunning, 50)
	final := reportRootProviderTurn(t, store, "root", "root-turn", "provider-guidance", RootProviderTurnPhaseCompleted, 60)
	if !final.RootTurnAccepted || final.RootTurn.Phase != TurnPhaseSettled ||
		final.RootTurn.Outcome != TurnOutcomeCompleted {
		t.Fatalf("guidance provider completion = %#v", final)
	}
}

func reportRootProviderTurn(
	t *testing.T,
	store *Store,
	rootSessionID string,
	rootTurnID string,
	providerTurnID string,
	phase string,
	occurredAtUnixMS int64,
) ActivityStateReportResult {
	t.Helper()
	outcome := ""
	if phase == RootProviderTurnPhaseCompleted {
		outcome = TurnOutcomeCompleted
	}
	result, err := store.ReportActivityState(context.Background(), ActivityStateReport{
		Session: SessionStateReport{
			WorkspaceID: "ws-1", AgentSessionID: rootSessionID, OccurredAtUnixMS: occurredAtUnixMS,
		},
		RootProviderTurn: &RootProviderTurnTransition{
			WorkspaceID: "ws-1", RootAgentSessionID: rootSessionID, RootTurnID: rootTurnID,
			ProviderTurnID: providerTurnID,
			ProviderTurnBindingJSON: json.RawMessage(
				`{"schemaVersion":1}`,
			),
			Phase: phase, Outcome: outcome,
			OccurredAtUnixMS: occurredAtUnixMS,
		},
	})
	if err != nil {
		t.Fatalf("ReportActivityState(root provider turn) error = %v", err)
	}
	return result
}
