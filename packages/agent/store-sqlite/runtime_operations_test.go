package storesqlite

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
)

func TestRuntimeOperationPrepareIsSubjectIdempotentAndCrashRecoverable(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	seedRuntimeInteractiveSubject(t, store, "session-1", "turn-1", "request-1")
	input := RuntimeOperationPrepare{OperationID: "operation-1", WorkspaceID: "ws-1", AgentSessionID: "session-1",
		Kind: RuntimeOperationKindInteractiveResponse, TurnID: "turn-1", RequestID: "request-1",
		Payload: map[string]any{"answer": "yes"}, OccurredAtMS: 10}
	first, created, err := store.PrepareRuntimeOperation(context.Background(), input)
	if err != nil || !created || first.Status != RuntimeOperationStatusPrepared {
		t.Fatalf("prepare = %#v created=%v err=%v", first, created, err)
	}
	input.OperationID = "operation-retry"
	duplicate, created, err := store.PrepareRuntimeOperation(context.Background(), input)
	if err != nil || created || duplicate.OperationID != "operation-1" {
		t.Fatalf("duplicate = %#v created=%v err=%v", duplicate, created, err)
	}
	claimable, err := store.ListClaimableRuntimeOperations(context.Background(), ListClaimableRuntimeOperationsInput{WorkspaceID: "ws-1", NowUnixMS: 20})
	if err != nil || len(claimable) != 1 || claimable[0].Status != RuntimeOperationStatusPrepared {
		t.Fatalf("claimable after crash = %#v err=%v", claimable, err)
	}
}

func TestPrepareInteractiveRuntimeOperationClaimsInteractionAtomically(t *testing.T) {
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	seedRuntimeInteractiveSubject(t, store, "session-claim", "turn-claim", "request-claim")
	start := make(chan struct{})
	type result struct {
		interaction Interaction
		transition  InteractionTransitionResult
		err         error
	}
	results := make(chan result, 2)
	var group sync.WaitGroup
	for index, option := range []string{"approve", "deny"} {
		index, option := index, option
		group.Add(1)
		go func() {
			defer group.Done()
			<-start
			_, interaction, transition, err := store.PrepareInteractiveRuntimeOperation(context.Background(), RuntimeOperationPrepare{
				OperationID: fmt.Sprintf("operation-%d", index), WorkspaceID: "ws-1", AgentSessionID: "session-claim",
				Kind: RuntimeOperationKindInteractiveResponse, TurnID: "turn-claim", RequestID: "request-claim",
				Payload: map[string]any{"action": "", "optionId": option, "payload": (map[string]any)(nil)}, OccurredAtMS: int64(10 + index),
			})
			results <- result{interaction: interaction, transition: transition, err: err}
		}()
	}
	close(start)
	group.Wait()
	close(results)
	applied := 0
	claimedOption := ""
	for got := range results {
		if got.err != nil {
			t.Fatalf("PrepareInteractiveRuntimeOperation() error = %v", got.err)
		}
		if got.transition == InteractionTransitionApplied {
			applied++
		}
		option, _ := got.interaction.Output["optionId"].(string)
		if claimedOption == "" {
			claimedOption = option
		} else if option != claimedOption {
			t.Fatalf("competing calls observed different claimed outputs: %q and %q", claimedOption, option)
		}
	}
	if applied != 1 || (claimedOption != "approve" && claimedOption != "deny") {
		t.Fatalf("applied claims=%d claimed option=%q", applied, claimedOption)
	}
	interactions, err := store.ListSessionInteractions(context.Background(), ListSessionInteractionsInput{
		WorkspaceID: "ws-1", AgentSessionID: "session-claim",
	})
	if err != nil || len(interactions) != 1 || interactions[0].Status != InteractionStatusAnswered {
		t.Fatalf("stored interactions=%#v error=%v", interactions, err)
	}
}

func TestRuntimeOperationLeaseUsesClockAndAllowsExpiredTakeover(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	seedRuntimeInteractiveSubject(t, store, "session-1", "turn-1", "request-1")
	prepareRuntimeInteractive(t, store, "operation-1", "session-1", "turn-1", "request-1")
	first, claimed, err := store.ClaimRuntimeOperationLease(context.Background(), ClaimRuntimeOperationLeaseInput{
		WorkspaceID: "ws-1", OperationID: "operation-1", LeaseOwner: "worker-a", NowUnixMS: 20, LeaseExpiresAtMS: 30})
	if err != nil || !claimed || first.Attempt != 1 {
		t.Fatalf("first claim = %#v claimed=%v err=%v", first, claimed, err)
	}
	_, claimed, err = store.ClaimRuntimeOperationLease(context.Background(), ClaimRuntimeOperationLeaseInput{
		WorkspaceID: "ws-1", OperationID: "operation-1", LeaseOwner: "worker-b", NowUnixMS: 29, LeaseExpiresAtMS: 40})
	if err != nil || claimed {
		t.Fatalf("early takeover claimed=%v err=%v", claimed, err)
	}
	taken, claimed, err := store.ClaimRuntimeOperationLease(context.Background(), ClaimRuntimeOperationLeaseInput{
		WorkspaceID: "ws-1", OperationID: "operation-1", LeaseOwner: "worker-b", NowUnixMS: 30, LeaseExpiresAtMS: 50})
	if err != nil || !claimed || taken.Attempt != 2 || taken.LeaseOwner != "worker-b" {
		t.Fatalf("expired takeover = %#v claimed=%v err=%v", taken, claimed, err)
	}
	released, changed, err := store.ReleaseOrFailRuntimeOperation(context.Background(), ReleaseOrFailRuntimeOperationInput{
		WorkspaceID: "ws-1", OperationID: "operation-1", LeaseOwner: "worker-b",
		NowUnixMS: 60, NextAttemptAtMS: 100, LastError: "retry later",
	})
	if err != nil || !changed || released.NextAttemptAtMS != 100 {
		t.Fatalf("release = %#v changed=%v err=%v", released, changed, err)
	}
	for now, wantCount := range map[int64]int{99: 0, 100: 1} {
		claimable, err := store.ListClaimableRuntimeOperations(context.Background(), ListClaimableRuntimeOperationsInput{
			WorkspaceID: "ws-1", NowUnixMS: now,
		})
		if err != nil || len(claimable) != wantCount {
			t.Fatalf("claimable at %d = %#v err=%v, want %d", now, claimable, err, wantCount)
		}
	}
}

func TestStartupRecoveryRequeuesUnexpiredRuntimeOperationLease(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	seedRuntimeInteractiveSubject(t, store, "session-1", "turn-1", "request-1")
	prepareRuntimeInteractive(t, store, "operation-1", "session-1", "turn-1", "request-1")
	_, claimed, err := store.ClaimRuntimeOperationLease(context.Background(), ClaimRuntimeOperationLeaseInput{
		WorkspaceID: "ws-1", OperationID: "operation-1", LeaseOwner: "dead-worker",
		NowUnixMS: 20, LeaseExpiresAtMS: 1000,
	})
	if err != nil || !claimed {
		t.Fatalf("claim unexpired lease claimed=%v err=%v", claimed, err)
	}
	count, err := store.RequeueLeasedRuntimeOperationsOnStartup(context.Background(), 30)
	if err != nil || count != 1 {
		t.Fatalf("startup requeue count=%d err=%v", count, err)
	}
	op, found, err := store.GetRuntimeOperation(context.Background(), "ws-1", "operation-1")
	if err != nil || !found || op.Status != RuntimeOperationStatusPrepared || op.LeaseOwner != "" || op.NextAttemptAtMS != 30 {
		t.Fatalf("requeued operation=%#v found=%v err=%v", op, found, err)
	}
	claimable, err := store.ListClaimableRuntimeOperations(context.Background(), ListClaimableRuntimeOperationsInput{NowUnixMS: 30})
	if err != nil || len(claimable) != 1 || claimable[0].OperationID != "operation-1" {
		t.Fatalf("startup claimable=%#v err=%v", claimable, err)
	}
}

func TestCompleteInteractiveRuntimeOperationIsAtomicAndSessionScoped(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	for _, sessionID := range []string{"session-1", "session-2"} {
		seedRuntimeInteractiveSubject(t, store, sessionID, "turn-1", "same-request")
	}
	prepareRuntimeInteractive(t, store, "operation-1", "session-1", "turn-1", "same-request")
	claimRuntimeOperation(t, store, "operation-1", "worker-a")
	completion, changed, err := store.CompleteInteractiveRuntimeOperation(context.Background(), CompleteInteractiveRuntimeOperationInput{
		WorkspaceID: "ws-1", OperationID: "operation-1", LeaseOwner: "worker-a", Disposition: InteractionStatusAnswered, NowUnixMS: 30})
	if err != nil || !changed || completion.Operation.Result != RuntimeOperationResultAnswered {
		t.Fatalf("completion = %#v changed=%v err=%v", completion, changed, err)
	}
	for sessionID, want := range map[string]string{"session-1": InteractionStatusAnswered, "session-2": InteractionStatusPending} {
		var status string
		err := store.db.QueryRow(`SELECT status FROM workspace_agent_interactions WHERE workspace_id = 'ws-1' AND agent_session_id = ? AND request_id = 'same-request'`, sessionID).Scan(&status)
		if err != nil || status != want {
			t.Fatalf("interaction %s status=%q err=%v", sessionID, status, err)
		}
	}
	events, err := store.ListPendingRuntimeOperationEvents(context.Background(), "ws-1", 10)
	if err != nil || len(events) != 1 || events[0].OperationID != "operation-1" {
		t.Fatalf("events = %#v err=%v", events, err)
	}
}

func TestCompleteInteractiveRuntimeOperationPreservesRuntimeSupersededAfterClaim(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	seedRuntimeInteractiveSubject(t, store, "session-claim", "turn-claim", "request-claim")
	operation, interaction, transition, err := store.PrepareInteractiveRuntimeOperation(context.Background(), RuntimeOperationPrepare{
		OperationID: "operation-claim", WorkspaceID: "ws-1", AgentSessionID: "session-claim",
		Kind: RuntimeOperationKindInteractiveResponse, TurnID: "turn-claim", RequestID: "request-claim",
		Payload: map[string]any{"action": "approve", "optionId": "", "payload": (map[string]any)(nil)}, OccurredAtMS: 10,
	})
	if err != nil || transition != InteractionTransitionApplied || interaction.Status != InteractionStatusAnswered {
		t.Fatalf("prepare claim operation=%#v interaction=%#v transition=%v error=%v", operation, interaction, transition, err)
	}
	claimRuntimeOperation(t, store, operation.OperationID, "worker-a")
	completion, changed, err := store.CompleteInteractiveRuntimeOperation(context.Background(), CompleteInteractiveRuntimeOperationInput{
		WorkspaceID: "ws-1", OperationID: operation.OperationID, LeaseOwner: "worker-a",
		Disposition: InteractionStatusSuperseded, NowUnixMS: 30,
	})
	if err != nil || !changed || completion.Operation.Result != RuntimeOperationResultSuperseded {
		t.Fatalf("completion=%#v changed=%v error=%v, want runtime superseded", completion, changed, err)
	}
	interactions, err := store.ListSessionInteractions(context.Background(), ListSessionInteractionsInput{
		WorkspaceID: "ws-1", AgentSessionID: "session-claim",
	})
	if err != nil || len(interactions) != 1 || interactions[0].Status != InteractionStatusAnswered {
		t.Fatalf("claimed interaction=%#v error=%v", interactions, err)
	}
}

func TestInteractiveAnswerAndCallCompletionConvergeWhenCommittedConcurrently(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	seedRuntimeInteractiveSubject(t, store, "session-1", "turn-1", "request-1")
	prepareRuntimeInteractive(t, store, "operation-1", "session-1", "turn-1", "request-1")
	claimRuntimeOperation(t, store, "operation-1", "worker-a")

	start := make(chan struct{})
	errors := make(chan error, 2)
	var ready sync.WaitGroup
	ready.Add(2)
	go func() {
		ready.Done()
		<-start
		_, _, err := store.CompleteInteractiveRuntimeOperation(context.Background(), CompleteInteractiveRuntimeOperationInput{
			WorkspaceID: "ws-1", OperationID: "operation-1", LeaseOwner: "worker-a",
			Disposition: InteractionStatusAnswered, NowUnixMS: 30,
		})
		errors <- err
	}()
	go func() {
		ready.Done()
		<-start
		result, err := store.ReportSessionMessages(context.Background(), SessionMessageReport{
			WorkspaceID: "ws-1", AgentSessionID: "session-1", Origin: "runtime", Provider: "codex",
			Messages: []MessageUpdate{{
				MessageID: "toolcall:call-1", TurnID: "turn-1", Role: "assistant", Kind: "tool_call",
				Status: "completed", Payload: map[string]any{"callId": "call-1", "toolName": "AskUserQuestion"},
				OccurredAtUnixMS: 31, CompletedAtUnixMS: 31,
			}},
		})
		if err == nil && result.AcceptedCount != 1 {
			err = fmt.Errorf("accepted call completion count = %d", result.AcceptedCount)
		}
		errors <- err
	}()
	ready.Wait()
	close(start)
	for range 2 {
		if err := <-errors; err != nil {
			t.Fatalf("concurrent commit error = %v", err)
		}
	}

	interactions, err := store.ListSessionInteractions(context.Background(), ListSessionInteractionsInput{
		WorkspaceID: "ws-1", AgentSessionID: "session-1",
	})
	if err != nil || len(interactions) != 1 || interactions[0].Status != InteractionStatusAnswered {
		t.Fatalf("interactions = %#v error=%v, want answered", interactions, err)
	}
	page, ok, err := store.ListSessionMessages(context.Background(), ListSessionMessagesInput{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", Limit: 10,
	})
	if err != nil || !ok || len(page.Messages) != 1 || page.Messages[0].Status != "completed" {
		t.Fatalf("messages = %#v ok=%v error=%v, want persisted call.completed", page.Messages, ok, err)
	}
}

func TestRuntimeOperationCompletionRollsBackDomainMutationOnOutboxFailure(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	seedRuntimeInteractiveSubject(t, store, "session-1", "turn-1", "request-1")
	prepareRuntimeInteractive(t, store, "operation-1", "session-1", "turn-1", "request-1")
	claimRuntimeOperation(t, store, "operation-1", "worker-a")
	if _, err := store.db.Exec(`CREATE TRIGGER fail_runtime_event BEFORE INSERT ON workspace_agent_runtime_operation_events BEGIN SELECT RAISE(ABORT, 'event failure'); END;`); err != nil {
		t.Fatalf("create failure trigger: %v", err)
	}
	_, _, err := store.CompleteInteractiveRuntimeOperation(context.Background(), CompleteInteractiveRuntimeOperationInput{
		WorkspaceID: "ws-1", OperationID: "operation-1", LeaseOwner: "worker-a", Disposition: InteractionStatusAnswered, NowUnixMS: 30})
	if err == nil {
		t.Fatal("completion error = nil, want outbox failure")
	}
	var interactionStatus string
	_ = store.db.QueryRow(`SELECT status FROM workspace_agent_interactions WHERE workspace_id = 'ws-1' AND agent_session_id = 'session-1' AND request_id = 'request-1'`).Scan(&interactionStatus)
	op, _, _ := store.GetRuntimeOperation(context.Background(), "ws-1", "operation-1")
	if interactionStatus != InteractionStatusPending || op.Status != RuntimeOperationStatusLeased {
		t.Fatalf("rollback interaction=%q operation=%#v", interactionStatus, op)
	}
}

func TestCompleteCancelRuntimeOperationSettlesExactTurnAndSupersedesPending(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	seedRuntimeInteractiveSubject(t, store, "session-1", "turn-1", "request-1")
	_, created, err := store.PrepareRuntimeOperation(context.Background(), RuntimeOperationPrepare{
		OperationID: "cancel-1", WorkspaceID: "ws-1", AgentSessionID: "session-1",
		Kind: RuntimeOperationKindCancelTurn, TurnID: "turn-1", OccurredAtMS: 10,
		Payload: map[string]any{"rootAgentSessionId": "session-1", "targets": []any{
			map[string]any{"agentSessionId": "session-1", "turnId": "turn-1"},
		}},
	})
	if err != nil || !created {
		t.Fatalf("prepare cancel created=%v err=%v", created, err)
	}
	claimRuntimeOperation(t, store, "cancel-1", "worker-a")
	// The runtime's local context can finish first and report its transport
	// error before the durable cancel operation commits. User cancellation is
	// still the canonical outcome, so completion must remove this error even
	// when the target turn is already settled.
	if _, err := store.ReportActivityState(context.Background(), ActivityStateReport{
		Session: SessionStateReport{
			WorkspaceID: "ws-1", AgentSessionID: "session-1", Kind: SessionKindRoot,
			Provider: "codex", OccurredAtUnixMS: 25,
		},
		Turn: &TurnTransition{
			WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: "turn-1",
			Phase: TurnPhaseSettled, Outcome: TurnOutcomeCanceled,
			ErrorMessage: "context canceled", OccurredAtUnixMS: 25,
		},
	}); err != nil {
		t.Fatalf("report local cancel terminal: %v", err)
	}
	completion, changed, err := store.CompleteCancelRuntimeOperation(context.Background(), CompleteCancelRuntimeOperationInput{
		WorkspaceID: "ws-1", OperationID: "cancel-1", LeaseOwner: "worker-a",
		TargetOutcomes: []CancelRuntimeOperationTargetOutcome{{
			AgentSessionID: "session-1", TurnID: "turn-1", Outcome: TurnOutcomeCanceled,
		}},
		NowUnixMS: 30,
	})
	if err != nil || !changed || completion.Operation.Result != RuntimeOperationResultCanceled {
		t.Fatalf("cancel completion=%#v changed=%v err=%v", completion, changed, err)
	}
	turn, found, err := store.GetTurn(context.Background(), "ws-1", "session-1", "turn-1")
	if err != nil || !found || turn.Phase != TurnPhaseSettled || turn.Outcome != TurnOutcomeCanceled || turn.ErrorMessage != "" {
		t.Fatalf("turn=%#v found=%v err=%v", turn, found, err)
	}
	session, found, err := store.GetSession(context.Background(), "ws-1", "session-1")
	if err != nil || !found || session.ActiveTurnID != "" {
		t.Fatalf("session=%#v found=%v err=%v", session, found, err)
	}
	var status string
	_ = store.db.QueryRow(`SELECT status FROM workspace_agent_interactions WHERE workspace_id = 'ws-1' AND agent_session_id = 'session-1' AND request_id = 'request-1'`).Scan(&status)
	if status != InteractionStatusSuperseded {
		t.Fatalf("interaction status=%q", status)
	}
}

func TestCompleteCancelRuntimeOperationSettlesRootAndUnconfirmedChildAtomically(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	reportSessionWithTurn(t, store, SessionStateReport{
		WorkspaceID: "ws-1", AgentSessionID: "root", Kind: SessionKindRoot,
		Provider: "codex", OccurredAtUnixMS: 10,
	}, "root-turn", 10)
	reportSessionWithTurn(t, store, SessionStateReport{
		WorkspaceID: "ws-1", AgentSessionID: "child", Kind: SessionKindChild,
		RootAgentSessionID: "root", RootTurnID: "root-turn",
		ParentAgentSessionID: "root", ParentTurnID: "root-turn", ParentToolCallID: "spawn-1",
		Provider: "codex", OccurredAtUnixMS: 20,
	}, "child-turn", 20)

	_, created, err := store.PrepareRuntimeOperation(context.Background(), RuntimeOperationPrepare{
		OperationID: "cancel-tree", WorkspaceID: "ws-1", AgentSessionID: "root",
		Kind: RuntimeOperationKindCancelTurn, TurnID: "root-turn", OccurredAtMS: 20,
		Payload: map[string]any{"rootAgentSessionId": "root", "targets": []any{
			map[string]any{"agentSessionId": "child", "turnId": "child-turn"},
			map[string]any{"agentSessionId": "root", "turnId": "root-turn"},
		}},
	})
	if err != nil || !created {
		t.Fatalf("prepare aggregate cancel created=%v err=%v", created, err)
	}
	claimRuntimeOperation(t, store, "cancel-tree", "worker-a")
	if _, changed, err := store.CompleteCancelRuntimeOperation(context.Background(), CompleteCancelRuntimeOperationInput{
		WorkspaceID: "ws-1", OperationID: "cancel-tree", LeaseOwner: "worker-a",
		TargetOutcomes: []CancelRuntimeOperationTargetOutcome{
			{AgentSessionID: "child", TurnID: "child-turn", Outcome: TurnOutcomeInterrupted},
			{AgentSessionID: "root", TurnID: "root-turn", Outcome: TurnOutcomeCanceled},
		},
		NowUnixMS: 30,
	}); err != nil || !changed {
		t.Fatalf("complete aggregate cancel changed=%v err=%v", changed, err)
	}
	for sessionID, expected := range map[string]struct {
		turnID  string
		outcome string
	}{
		"root":  {turnID: "root-turn", outcome: TurnOutcomeCanceled},
		"child": {turnID: "child-turn", outcome: TurnOutcomeInterrupted},
	} {
		turnID := expected.turnID
		turn, found, err := store.GetTurn(context.Background(), "ws-1", sessionID, turnID)
		if err != nil || !found || turn.Phase != TurnPhaseSettled || turn.Outcome != expected.outcome {
			t.Fatalf("target %s/%s turn=%#v found=%v err=%v", sessionID, turnID, turn, found, err)
		}
		session, found, err := store.GetSession(context.Background(), "ws-1", sessionID)
		if err != nil || !found || session.ActiveTurnID != "" {
			t.Fatalf("target %s session=%#v found=%v err=%v", sessionID, session, found, err)
		}
	}
}

func TestPreparedRootCancelRejectsLateChildCreation(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	reportSessionWithTurn(t, store, SessionStateReport{
		WorkspaceID: "ws-1", AgentSessionID: "root", Kind: SessionKindRoot,
		Provider: "codex", OccurredAtUnixMS: 10,
	}, "root-turn", 10)

	if _, created, err := store.PrepareRuntimeOperation(context.Background(), RuntimeOperationPrepare{
		OperationID: "cancel-root", WorkspaceID: "ws-1", AgentSessionID: "root",
		Kind: RuntimeOperationKindCancelTurn, TurnID: "root-turn", OccurredAtMS: 20,
		Payload: map[string]any{"rootAgentSessionId": "root", "targets": []any{
			map[string]any{"agentSessionId": "root", "turnId": "root-turn"},
		}},
	}); err != nil || !created {
		t.Fatalf("prepare root cancel created=%v err=%v", created, err)
	}

	_, err := store.ReportActivityState(context.Background(), ActivityStateReport{
		Session: SessionStateReport{
			WorkspaceID: "ws-1", AgentSessionID: "late-child", Kind: SessionKindChild,
			RootAgentSessionID: "root", RootTurnID: "root-turn",
			ParentAgentSessionID: "root", ParentTurnID: "root-turn", ParentToolCallID: "spawn-late",
			Provider: "codex", OccurredAtUnixMS: 21,
		},
		Turn: &TurnTransition{
			WorkspaceID: "ws-1", AgentSessionID: "late-child", TurnID: "late-child-turn",
			Phase: TurnPhaseRunning, OccurredAtUnixMS: 21,
		},
	})
	if err == nil || !strings.Contains(err.Error(), "root turn cancellation started") {
		t.Fatalf("late child creation error = %v, want durable cancel boundary rejection", err)
	}
	if _, found, err := store.GetSession(context.Background(), "ws-1", "late-child"); err != nil || found {
		t.Fatalf("late child persisted found=%v err=%v", found, err)
	}
}

func TestCompleteChildCancelRuntimeOperationSettlesCompletedRootInSameTransaction(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	reportSessionWithTurn(t, store, SessionStateReport{
		WorkspaceID: "ws-1", AgentSessionID: "root", Kind: SessionKindRoot,
		Provider: "codex", OccurredAtUnixMS: 10,
	}, "root-turn", 10)
	reportSessionWithTurn(t, store, SessionStateReport{
		WorkspaceID: "ws-1", AgentSessionID: "child", Kind: SessionKindChild,
		RootAgentSessionID: "root", RootTurnID: "root-turn",
		ParentAgentSessionID: "root", ParentTurnID: "root-turn", ParentToolCallID: "spawn-1",
		Provider: "codex", OccurredAtUnixMS: 20,
	}, "child-turn", 20)
	providerCompleted := reportRootProviderTurn(t, store, "root", "root-turn", "provider-turn", RootProviderTurnPhaseCompleted, 30)
	if providerCompleted.RootTurn.Phase != TurnPhaseWaiting {
		t.Fatalf("root provider completion=%#v", providerCompleted)
	}

	_, created, err := store.PrepareRuntimeOperation(context.Background(), RuntimeOperationPrepare{
		OperationID: "cancel-child", WorkspaceID: "ws-1", AgentSessionID: "child",
		Kind: RuntimeOperationKindCancelTurn, TurnID: "child-turn", OccurredAtMS: 20,
		Payload: map[string]any{"rootAgentSessionId": "root", "targets": []any{
			map[string]any{"agentSessionId": "child", "turnId": "child-turn"},
		}},
	})
	if err != nil || !created {
		t.Fatalf("prepare child cancel created=%v err=%v", created, err)
	}
	claimRuntimeOperation(t, store, "cancel-child", "worker-a")
	if _, changed, err := store.CompleteCancelRuntimeOperation(context.Background(), CompleteCancelRuntimeOperationInput{
		WorkspaceID: "ws-1", OperationID: "cancel-child", LeaseOwner: "worker-a",
		TargetOutcomes: []CancelRuntimeOperationTargetOutcome{{
			AgentSessionID: "child", TurnID: "child-turn", Outcome: TurnOutcomeCanceled,
		}},
		NowUnixMS: 30,
	}); err != nil || !changed {
		t.Fatalf("complete child cancel changed=%v err=%v", changed, err)
	}

	root, found, err := store.GetTurn(context.Background(), "ws-1", "root", "root-turn")
	if err != nil || !found || root.Phase != TurnPhaseSettled || root.Outcome != TurnOutcomeCompleted {
		t.Fatalf("root=%#v found=%v err=%v", root, found, err)
	}
	events, err := store.ListPendingRuntimeOperationEvents(context.Background(), "ws-1", 10)
	if err != nil || len(events) != 1 {
		t.Fatalf("events=%#v err=%v", events, err)
	}
	reconciledRoot, ok := events[0].Payload["reconciledRoot"].(map[string]any)
	if !ok || payloadString(reconciledRoot, "agentSessionId") != "root" || payloadString(reconciledRoot, "turnId") != "root-turn" {
		t.Fatalf("reconciled root payload=%#v", events[0].Payload)
	}
}

func TestRuntimeOperationMigrationRerunsWhenSchemaExistsWithoutMarker(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	if _, err := store.db.Exec(`DELETE FROM agent_store_schema_migrations WHERE id = ?`, schemaMigrationWorkspaceAgentRuntimeOperationsV1); err != nil {
		t.Fatalf("delete migration marker: %v", err)
	}
	if err := store.Migrate(context.Background()); err != nil {
		t.Fatalf("rerun migration: %v", err)
	}
}

func TestRuntimeOperationGlobalRecoveryOrdersAndLimitsAcrossWorkspaces(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	for _, seed := range []struct {
		workspaceID string
		operationID string
		createdAt   int64
	}{
		{workspaceID: "ws-1", operationID: "operation-1", createdAt: 10},
		{workspaceID: "ws-2", operationID: "operation-2", createdAt: 11},
	} {
		seedRuntimeInteractiveSubjectInWorkspace(t, store, seed.workspaceID, "session-1", "turn-1", "request-1")
		_, created, err := store.PrepareRuntimeOperation(context.Background(), RuntimeOperationPrepare{
			OperationID: seed.operationID, WorkspaceID: seed.workspaceID, AgentSessionID: "session-1",
			Kind: RuntimeOperationKindInteractiveResponse, TurnID: "turn-1", RequestID: "request-1", OccurredAtMS: seed.createdAt,
		})
		if err != nil || !created {
			t.Fatalf("prepare %s created=%v err=%v", seed.operationID, created, err)
		}
		if _, err := store.db.Exec(`
INSERT INTO workspace_agent_runtime_operation_events
  (operation_id, workspace_id, agent_session_id, kind, payload_json, created_at_unix_ms)
VALUES (?, ?, 'session-1', 'interactive_completed', '{}', ?)
`, seed.operationID, seed.workspaceID, seed.createdAt); err != nil {
			t.Fatalf("insert event %s: %v", seed.operationID, err)
		}
	}
	operations, err := store.ListClaimableRuntimeOperations(context.Background(), ListClaimableRuntimeOperationsInput{NowUnixMS: 20, Limit: 1})
	if err != nil || len(operations) != 1 || operations[0].OperationID != "operation-1" {
		t.Fatalf("global operations=%#v err=%v", operations, err)
	}
	events, err := store.ListPendingRuntimeOperationEvents(context.Background(), "", 1)
	if err != nil || len(events) != 1 || events[0].OperationID != "operation-1" {
		t.Fatalf("global events=%#v err=%v", events, err)
	}
}

func seedRuntimeInteractiveSubject(t *testing.T, store *Store, sessionID string, turnID string, requestID string) {
	t.Helper()
	seedRuntimeInteractiveSubjectInWorkspace(t, store, "ws-1", sessionID, turnID, requestID)
}

func seedRuntimeInteractiveSubjectInWorkspace(t *testing.T, store *Store, workspaceID string, sessionID string, turnID string, requestID string) {
	t.Helper()
	seedTurnTestSession(t, store, workspaceID, sessionID)
	if _, accepted, err := store.RecordTurnTransition(context.Background(), TurnTransition{
		WorkspaceID: workspaceID, AgentSessionID: sessionID, TurnID: turnID, Phase: TurnPhaseWaiting, OccurredAtUnixMS: 2,
	}); err != nil || !accepted {
		t.Fatalf("seed turn accepted=%v err=%v", accepted, err)
	}
	if _, accepted, err := store.UpsertInteraction(context.Background(), InteractionUpsert{
		WorkspaceID: workspaceID, AgentSessionID: sessionID, TurnID: turnID, RequestID: requestID,
		Kind: InteractionKindQuestion, Status: InteractionStatusPending, OccurredAtUnixMS: 3,
	}); err != nil || accepted != InteractionTransitionApplied {
		t.Fatalf("seed interaction accepted=%v err=%v", accepted, err)
	}
}

func prepareRuntimeInteractive(t *testing.T, store *Store, operationID string, sessionID string, turnID string, requestID string) {
	t.Helper()
	_, created, err := store.PrepareRuntimeOperation(context.Background(), RuntimeOperationPrepare{
		OperationID: operationID, WorkspaceID: "ws-1", AgentSessionID: sessionID,
		Kind: RuntimeOperationKindInteractiveResponse, TurnID: turnID, RequestID: requestID, OccurredAtMS: 10,
	})
	if err != nil || !created {
		t.Fatalf("prepare operation created=%v err=%v", created, err)
	}
}

func claimRuntimeOperation(t *testing.T, store *Store, operationID string, owner string) {
	t.Helper()
	_, claimed, err := store.ClaimRuntimeOperationLease(context.Background(), ClaimRuntimeOperationLeaseInput{
		WorkspaceID: "ws-1", OperationID: operationID, LeaseOwner: owner, NowUnixMS: 20, LeaseExpiresAtMS: 40,
	})
	if err != nil || !claimed {
		t.Fatalf("claim operation claimed=%v err=%v", claimed, err)
	}
}
