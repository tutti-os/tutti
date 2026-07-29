package tuttimodeexecution_test

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sync"
	"time"

	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
	tuttimodeexecutionservice "github.com/tutti-os/tutti/services/tuttid/service/tuttimodeexecution"
	tuttimodeexecutionconformance "github.com/tutti-os/tutti/services/tuttid/service/tuttimodeexecution/conformance"
)

type recordingMainWakeTarget struct {
	mu                        sync.Mutex
	busy                      map[string]bool
	hang                      map[string]bool
	observationFailures       map[string]bool
	advanceDuringSend         map[string]func()
	observeCount              map[string]int
	activityBeforeClaim       map[string]func() error
	activityAfterClaim        map[string]func() error
	activityDuringSend        map[string]func() error
	deliveries                []tuttimodeexecutionconformance.WakeDelivery
	canonicalByClientSubmit   map[string]string
	settledAtByTurnID         map[string]time.Time
	failBeforeCanonical       bool
	failAmbiguousBefore       bool
	failAfterCanonical        bool
	armCanonicalLookupFailure bool
	failLookupClientSubmitID  string
	cancelDuringSend          context.CancelFunc
	cancelDeliveryOutcome     string
}

func newRecordingMainWakeTarget() *recordingMainWakeTarget {
	return &recordingMainWakeTarget{
		busy:                    make(map[string]bool),
		hang:                    make(map[string]bool),
		observationFailures:     make(map[string]bool),
		advanceDuringSend:       make(map[string]func()),
		observeCount:            make(map[string]int),
		activityBeforeClaim:     make(map[string]func() error),
		activityAfterClaim:      make(map[string]func() error),
		activityDuringSend:      make(map[string]func() error),
		canonicalByClientSubmit: make(map[string]string),
		settledAtByTurnID:       make(map[string]time.Time),
	}
}

type injectableWakeStore struct {
	tuttimodeexecutionservice.WakeStore
	mu            sync.Mutex
	claimFailures map[string]bool
}

func newInjectableWakeStore(store tuttimodeexecutionservice.WakeStore) *injectableWakeStore {
	return &injectableWakeStore{
		WakeStore:     store,
		claimFailures: make(map[string]bool),
	}
}

func (store *injectableWakeStore) ClaimTuttiModeExecutionWake(
	ctx context.Context,
	workspaceID string,
	wakeID string,
	leaseOwner string,
	now time.Time,
	leaseExpiresAt time.Time,
) (bool, error) {
	store.mu.Lock()
	fail := store.claimFailures[wakeID]
	if fail {
		delete(store.claimFailures, wakeID)
	}
	store.mu.Unlock()
	if fail {
		return false, errors.New("injected wake claim failure")
	}
	return store.WakeStore.ClaimTuttiModeExecutionWake(
		ctx, workspaceID, wakeID, leaseOwner, now, leaseExpiresAt,
	)
}

func wakeTargetKey(workspaceID string, sessionID string) string {
	return workspaceID + "\x00" + sessionID
}

func (target *recordingMainWakeTarget) ObserveSourceSession(
	_ context.Context,
	workspaceID string,
	sessionID string,
) (tuttimodeexecutionservice.SourceSessionObservation, error) {
	target.mu.Lock()
	key := wakeTargetKey(workspaceID, sessionID)
	target.observeCount[key]++
	beforeClaim := target.activityBeforeClaim[key]
	if target.observeCount[key] != 1 {
		beforeClaim = nil
	} else {
		delete(target.activityBeforeClaim, key)
	}
	afterClaim := target.activityAfterClaim[key]
	if target.observeCount[key] != 2 {
		afterClaim = nil
	} else {
		delete(target.activityAfterClaim, key)
	}
	failed := target.observationFailures[key]
	busy := target.busy[key]
	target.mu.Unlock()
	if beforeClaim != nil {
		if err := beforeClaim(); err != nil {
			return tuttimodeexecutionservice.SourceSessionObservation{}, err
		}
	}
	if afterClaim != nil {
		if err := afterClaim(); err != nil {
			return tuttimodeexecutionservice.SourceSessionObservation{}, err
		}
	}
	if failed {
		return tuttimodeexecutionservice.SourceSessionObservation{},
			errors.New("injected permanent source observation failure")
	}
	return tuttimodeexecutionservice.SourceSessionObservation{
		Exists: true,
		Busy:   busy,
	}, nil
}

func (target *recordingMainWakeTarget) SendMainWake(
	ctx context.Context,
	workspaceID string,
	sessionID string,
	clientSubmitID string,
	prompt string,
) (tuttimodeexecutionservice.MainWakeDelivery, error) {
	deadline, hadDeadline := ctx.Deadline()
	deadlineBudget := time.Duration(0)
	if hadDeadline {
		deadlineBudget = time.Until(deadline)
	}
	target.mu.Lock()
	target.deliveries = append(target.deliveries, tuttimodeexecutionconformance.WakeDelivery{
		TargetSessionID: sessionID, ClientSubmitID: clientSubmitID, Prompt: prompt,
		HadDeadline: hadDeadline, DeadlineBudget: deadlineBudget,
	})
	key := wakeTargetKey(workspaceID, sessionID)
	cancelCaller := target.cancelDuringSend
	cancelOutcome := target.cancelDeliveryOutcome
	target.cancelDuringSend = nil
	target.cancelDeliveryOutcome = ""
	if cancelCaller != nil && cancelOutcome == "before-canonical-error" {
		target.mu.Unlock()
		cancelCaller()
		return tuttimodeexecutionservice.MainWakeDelivery{},
			errors.New("injected caller cancellation before canonical delivery")
	}
	if target.hang[key] {
		delete(target.hang, key)
		target.mu.Unlock()
		if !hadDeadline {
			return tuttimodeexecutionservice.MainWakeDelivery{},
				errors.New("SendMainWake was not bounded")
		}
		<-ctx.Done()
		return tuttimodeexecutionservice.MainWakeDelivery{}, ctx.Err()
	}
	if target.failBeforeCanonical {
		target.failBeforeCanonical = false
		target.mu.Unlock()
		return tuttimodeexecutionservice.MainWakeDelivery{}, errors.New("injected definite pre-canonical failure")
	}
	if target.failAmbiguousBefore {
		target.failAmbiguousBefore = false
		target.mu.Unlock()
		return tuttimodeexecutionservice.MainWakeDelivery{}, errors.New("injected ambiguous pre-canonical failure")
	}
	turnID := target.canonicalByClientSubmit[clientSubmitID]
	if turnID == "" {
		turnID = fmt.Sprintf("wake-turn-%d", len(target.canonicalByClientSubmit)+1)
		target.canonicalByClientSubmit[clientSubmitID] = turnID
	}
	if target.failAfterCanonical {
		target.failAfterCanonical = false
		if target.armCanonicalLookupFailure {
			target.armCanonicalLookupFailure = false
			target.failLookupClientSubmitID = clientSubmitID
		}
		target.mu.Unlock()
		return tuttimodeexecutionservice.MainWakeDelivery{}, errors.New("injected response loss")
	}
	advance := target.advanceDuringSend[key]
	delete(target.advanceDuringSend, key)
	activityDuringSend := target.activityDuringSend[key]
	delete(target.activityDuringSend, key)
	target.mu.Unlock()
	if cancelCaller != nil {
		cancelCaller()
		if cancelOutcome == "after-canonical-error" {
			return tuttimodeexecutionservice.MainWakeDelivery{},
				errors.New("injected caller cancellation after canonical delivery")
		}
	}
	if advance != nil {
		advance()
	}
	if activityDuringSend != nil {
		if err := activityDuringSend(); err != nil {
			return tuttimodeexecutionservice.MainWakeDelivery{}, err
		}
	}
	return tuttimodeexecutionservice.MainWakeDelivery{
		CanonicalSessionID: sessionID,
		CanonicalTurnID:    turnID,
	}, nil
}

func (target *recordingMainWakeTarget) FindMainWakeTurn(
	ctx context.Context,
	_ string,
	_ string,
	clientSubmitID string,
) (string, bool, error) {
	if err := ctx.Err(); err != nil {
		return "", false, err
	}
	target.mu.Lock()
	defer target.mu.Unlock()
	if target.failLookupClientSubmitID == clientSubmitID {
		target.failLookupClientSubmitID = ""
		return "", false, errors.New("injected canonical lookup outage")
	}
	turnID := target.canonicalByClientSubmit[clientSubmitID]
	return turnID, turnID != "", nil
}

func (target *recordingMainWakeTarget) ReadMainWakeTurn(
	ctx context.Context,
	workspaceID string,
	sessionID string,
	clientSubmitID string,
) (tuttimodeexecutionservice.MainWakeTurnObservation, bool, error) {
	turnID, found, err := target.FindMainWakeTurn(
		ctx, workspaceID, sessionID, clientSubmitID,
	)
	if err != nil || !found {
		return tuttimodeexecutionservice.MainWakeTurnObservation{}, found, err
	}
	target.mu.Lock()
	settledAt := target.settledAtByTurnID[turnID]
	target.mu.Unlock()
	return tuttimodeexecutionservice.MainWakeTurnObservation{
		CanonicalTurnID: turnID,
		SettledAt:       settledAt,
	}, true, nil
}

func (driver *sqliteConformanceDriver) ListWakes(
	ctx context.Context,
	workspaceID string,
	issueID string,
) ([]tuttimodeexecutionconformance.Wake, error) {
	items, err := driver.executions.ListWakes(ctx, workspaceID, issueID)
	if err != nil {
		return nil, err
	}
	result := make([]tuttimodeexecutionconformance.Wake, 0, len(items))
	for _, item := range items {
		result = append(result, tuttimodeexecutionconformance.Wake{
			WakeID: item.ID, ExecutionID: item.ExecutionID,
			CheckpointID: item.CheckpointID, TargetKind: string(item.TargetKind),
			WakeSequence: item.Sequence, ClientSubmitID: item.ClientSubmitID,
			TargetSessionID:    item.TargetSessionID,
			CanonicalSessionID: item.CanonicalSessionID,
			CanonicalTurnID:    item.CanonicalTurnID, Status: string(item.Status),
			AttemptCount: item.AttemptCount, LeaseOwner: item.LeaseOwner,
			DueAt: item.DueAt, LeaseExpiresAt: item.LeaseExpiresAt,
		})
	}
	return result, nil
}

func (driver *sqliteConformanceDriver) ClaimWake(
	ctx context.Context,
	workspaceID string,
	wakeID string,
	leaseOwner string,
	duration time.Duration,
) (bool, error) {
	return driver.executions.ClaimMainWake(
		ctx, workspaceID, wakeID, leaseOwner, duration,
	)
}

func (driver *sqliteConformanceDriver) DispatchClaimedWake(
	ctx context.Context,
	workspaceID string,
	wakeID string,
	leaseOwner string,
) error {
	return driver.executions.DispatchClaimedMainWake(
		ctx, workspaceID, wakeID, leaseOwner,
	)
}

func (driver *sqliteConformanceDriver) DispatchClaimedWakeWithCallerCancellation(
	ctx context.Context,
	workspaceID string,
	wakeID string,
	leaseOwner string,
	outcome string,
) error {
	callerCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	driver.wakeTarget.mu.Lock()
	driver.wakeTarget.cancelDuringSend = cancel
	driver.wakeTarget.cancelDeliveryOutcome = outcome
	driver.wakeTarget.mu.Unlock()
	return driver.executions.DispatchClaimedMainWake(
		callerCtx, workspaceID, wakeID, leaseOwner,
	)
}

func (driver *sqliteConformanceDriver) RecoverWakes(
	ctx context.Context,
	workspaceID string,
	leaseOwner string,
) error {
	return driver.executions.RecoverMainWakes(ctx, workspaceID, leaseOwner)
}

func (driver *sqliteConformanceDriver) StartupRecoverWakes(
	ctx context.Context,
	workspaceID string,
	leaseOwner string,
) error {
	fresh := tuttimodeexecutionservice.Service{
		Store: driver.store, Wakes: driver.wakeStore, MainWakeTargets: driver.wakeTarget,
		ReviewerActivity: driver.store, Clock: driver.clock.Now,
	}
	return fresh.StartupRecoverMainWakes(ctx, workspaceID, leaseOwner)
}

func (driver *sqliteConformanceDriver) SetSourceBusy(
	workspaceID string,
	sessionID string,
	busy bool,
) {
	driver.wakeTarget.mu.Lock()
	defer driver.wakeTarget.mu.Unlock()
	driver.wakeTarget.busy[wakeTargetKey(workspaceID, sessionID)] = busy
}

func (driver *sqliteConformanceDriver) FailNextWakeBeforeCanonical() {
	driver.wakeTarget.mu.Lock()
	defer driver.wakeTarget.mu.Unlock()
	driver.wakeTarget.failBeforeCanonical = true
}

func (driver *sqliteConformanceDriver) FailNextWakeAmbiguouslyBeforeCanonical() {
	driver.wakeTarget.mu.Lock()
	defer driver.wakeTarget.mu.Unlock()
	driver.wakeTarget.failAmbiguousBefore = true
}

func (driver *sqliteConformanceDriver) FailNextWakeAfterCanonical() {
	driver.wakeTarget.mu.Lock()
	defer driver.wakeTarget.mu.Unlock()
	driver.wakeTarget.failAfterCanonical = true
}

func (driver *sqliteConformanceDriver) FailNextWakeCanonicalLookup() {
	driver.wakeTarget.mu.Lock()
	defer driver.wakeTarget.mu.Unlock()
	driver.wakeTarget.armCanonicalLookupFailure = true
}

func (driver *sqliteConformanceDriver) SetMainWakeSendTimeout(timeout time.Duration) {
	driver.executions.MainWakeSendTimeout = timeout
}

func (driver *sqliteConformanceDriver) HangWakeUntilContextDone(
	workspaceID string,
	sessionID string,
) {
	driver.wakeTarget.mu.Lock()
	defer driver.wakeTarget.mu.Unlock()
	driver.wakeTarget.hang[wakeTargetKey(workspaceID, sessionID)] = true
}

func (driver *sqliteConformanceDriver) AdvanceClockDuringWake(
	workspaceID string,
	sessionID string,
	duration time.Duration,
) {
	driver.wakeTarget.mu.Lock()
	defer driver.wakeTarget.mu.Unlock()
	driver.wakeTarget.advanceDuringSend[wakeTargetKey(workspaceID, sessionID)] = func() {
		driver.clock.Advance(duration)
	}
}

func (driver *sqliteConformanceDriver) FailWakeObservation(
	workspaceID string,
	sessionID string,
) {
	driver.wakeTarget.mu.Lock()
	defer driver.wakeTarget.mu.Unlock()
	driver.wakeTarget.observationFailures[wakeTargetKey(workspaceID, sessionID)] = true
}

func (driver *sqliteConformanceDriver) FailWakeClaim(wakeID string) {
	driver.wakeStore.mu.Lock()
	defer driver.wakeStore.mu.Unlock()
	driver.wakeStore.claimFailures[wakeID] = true
}

func (driver *sqliteConformanceDriver) SeedPreparedReviewerWake(
	ctx context.Context,
	workspaceID string,
	issueID string,
) error {
	now := driver.clock.Now().UnixMilli()
	return driver.execWakeFixtureMutation(ctx, `
INSERT INTO workspace_tutti_execution_wakes (
  workspace_id, execution_id, checkpoint_id, wake_id, target_kind,
  wake_sequence, client_submit_id, target_session_id,
  review_agent_target_id, status, due_at_unix_ms,
  created_at_unix_ms, updated_at_unix_ms
)
SELECT e.workspace_id, e.execution_id, c.checkpoint_id,
       c.checkpoint_id || ':wake:reviewer:2', 'reviewer', 2,
       'tutti-execution-review:' || c.checkpoint_id || ':wake:reviewer:2',
       '', 'review-agent-target', 'prepared', ?, ?, ?
FROM workspace_tutti_executions e
JOIN workspace_tutti_execution_checkpoints c
  ON c.workspace_id = e.workspace_id AND c.execution_id = e.execution_id
WHERE e.workspace_id = ? AND e.issue_id = ? AND c.status = 'active'
`, now, now, now, workspaceID, issueID)
}

func (driver *sqliteConformanceDriver) CorruptWakeIdentity(
	ctx context.Context,
	workspaceID string,
	issueID string,
	field string,
	value string,
) error {
	switch field {
	case "wake_id", "client_submit_id", "target_kind", "wake_sequence", "target_session_id":
	default:
		return fmt.Errorf("unsupported wake identity field %q", field)
	}
	return driver.execWakeFixtureMutation(ctx, fmt.Sprintf(`
UPDATE workspace_tutti_execution_wakes
SET %s = ?
WHERE workspace_id = ? AND execution_id = (
  SELECT execution_id FROM workspace_tutti_executions
  WHERE workspace_id = ? AND issue_id = ?
)
`, field), value, workspaceID, workspaceID, issueID)
}

func (driver *sqliteConformanceDriver) SettleWakeTurn(
	ctx context.Context,
	workspaceID string,
	sessionID string,
	turnID string,
) error {
	return driver.executions.ObserveMainWakeTurnSettled(
		ctx, workspaceID, sessionID, turnID,
	)
}

func (driver *sqliteConformanceDriver) SettleWakeTurnAt(
	ctx context.Context,
	workspaceID string,
	sessionID string,
	turnID string,
	settledAt time.Time,
) error {
	return driver.executions.ObserveMainWakeTurnSettledAt(
		ctx, workspaceID, sessionID, turnID, settledAt,
	)
}

func (driver *sqliteConformanceDriver) SetExecutionStatus(
	ctx context.Context,
	workspaceID string,
	issueID string,
	status string,
) error {
	return driver.execWakeFixtureMutation(ctx, `
UPDATE workspace_tutti_executions SET status = ?
WHERE workspace_id = ? AND issue_id = ?
`, status, workspaceID, issueID)
}

func (driver *sqliteConformanceDriver) SetCanonicalWakeTurnSettledAt(
	workspaceID string,
	sessionID string,
	turnID string,
	settledAt time.Time,
) {
	_ = workspaceID
	_ = sessionID
	driver.wakeTarget.mu.Lock()
	driver.wakeTarget.settledAtByTurnID[turnID] = settledAt.UTC()
	driver.wakeTarget.mu.Unlock()
}

func (driver *sqliteConformanceDriver) ObserveSourceActivityAfterNextWakeClaim(
	ctx context.Context,
	activity tuttimodeexecutionconformance.SourceSessionActivity,
) {
	key := wakeTargetKey(activity.WorkspaceID, activity.SessionID)
	driver.wakeTarget.mu.Lock()
	driver.wakeTarget.observeCount[key] = 0
	driver.wakeTarget.activityAfterClaim[key] = func() error {
		occurredAt := activity.OccurredAt
		if occurredAt.IsZero() {
			occurredAt = driver.CurrentTime()
		}
		return driver.executions.ObserveSourceSessionActivity(
			ctx,
			tuttimodeexecutionservice.SourceSessionActivity{
				WorkspaceID: activity.WorkspaceID,
				SessionID:   activity.SessionID,
				Kind: tuttimodeexecutionservice.SourceSessionActivityKind(
					activity.Kind,
				),
				ActivityID: activity.ActivityID,
				OccurredAt: occurredAt,
			},
		)
	}
	driver.wakeTarget.mu.Unlock()
}

func (driver *sqliteConformanceDriver) CommitCanonicalSourceActivityBeforeNextWakeClaim(
	ctx context.Context,
	activity tuttimodeexecutionconformance.SourceSessionActivity,
	clientSubmitID string,
) {
	key := wakeTargetKey(activity.WorkspaceID, activity.SessionID)
	driver.wakeTarget.mu.Lock()
	driver.wakeTarget.observeCount[key] = 0
	driver.wakeTarget.activityBeforeClaim[key] = func() error {
		return driver.CommitCanonicalSourceActivity(ctx, activity, clientSubmitID)
	}
	driver.wakeTarget.mu.Unlock()
}

func (driver *sqliteConformanceDriver) CommitCanonicalSourceActivityAfterNextWakeClaim(
	ctx context.Context,
	activity tuttimodeexecutionconformance.SourceSessionActivity,
	clientSubmitID string,
) {
	key := wakeTargetKey(activity.WorkspaceID, activity.SessionID)
	driver.wakeTarget.mu.Lock()
	driver.wakeTarget.observeCount[key] = 0
	driver.wakeTarget.activityAfterClaim[key] = func() error {
		return driver.CommitCanonicalSourceActivity(ctx, activity, clientSubmitID)
	}
	driver.wakeTarget.mu.Unlock()
}

func (driver *sqliteConformanceDriver) ObserveSourceActivityDuringNextWakeSend(
	ctx context.Context,
	activity tuttimodeexecutionconformance.SourceSessionActivity,
) {
	key := wakeTargetKey(activity.WorkspaceID, activity.SessionID)
	driver.wakeTarget.mu.Lock()
	driver.wakeTarget.activityDuringSend[key] = func() error {
		occurredAt := activity.OccurredAt
		if occurredAt.IsZero() {
			occurredAt = driver.CurrentTime()
		}
		return driver.executions.ObserveSourceSessionActivity(
			ctx,
			tuttimodeexecutionservice.SourceSessionActivity{
				WorkspaceID: activity.WorkspaceID,
				SessionID:   activity.SessionID,
				Kind: tuttimodeexecutionservice.SourceSessionActivityKind(
					activity.Kind,
				),
				ActivityID: activity.ActivityID,
				OccurredAt: occurredAt,
			},
		)
	}
	driver.wakeTarget.mu.Unlock()
}

func (driver *sqliteConformanceDriver) CommitCanonicalSourceActivityDuringNextWakeSend(
	ctx context.Context,
	activity tuttimodeexecutionconformance.SourceSessionActivity,
	clientSubmitID string,
) {
	key := wakeTargetKey(activity.WorkspaceID, activity.SessionID)
	driver.wakeTarget.mu.Lock()
	driver.wakeTarget.activityDuringSend[key] = func() error {
		return driver.CommitCanonicalSourceActivity(ctx, activity, clientSubmitID)
	}
	driver.wakeTarget.mu.Unlock()
}

func (driver *sqliteConformanceDriver) StopSourceSessionDuringNextWakeSend(
	workspaceID string,
	sourceSessionID string,
) {
	key := wakeTargetKey(workspaceID, sourceSessionID)
	driver.wakeTarget.mu.Lock()
	driver.wakeTarget.activityDuringSend[key] = func() error {
		_, err := driver.StopSourceSession(
			context.Background(), workspaceID, sourceSessionID,
		)
		return err
	}
	driver.wakeTarget.mu.Unlock()
}

func (driver *sqliteConformanceDriver) CorruptWakeTargetSession(
	ctx context.Context,
	workspaceID string,
	issueID string,
	sessionID string,
) error {
	return driver.execWakeFixtureMutation(ctx, `
UPDATE workspace_tutti_execution_wakes
SET target_session_id = ?
WHERE workspace_id = ? AND execution_id = (
  SELECT execution_id FROM workspace_tutti_executions
  WHERE workspace_id = ? AND issue_id = ?
)
`, sessionID, workspaceID, workspaceID, issueID)
}

func (driver *sqliteConformanceDriver) ObserveSourceSessionActivity(
	ctx context.Context,
	activity tuttimodeexecutionconformance.SourceSessionActivity,
) error {
	kind := tuttimodeexecutionservice.SourceSessionActivityKind(activity.Kind)
	occurredAt := activity.OccurredAt
	if occurredAt.IsZero() {
		occurredAt = driver.CurrentTime()
	}
	return driver.executions.ObserveSourceSessionActivity(
		ctx, tuttimodeexecutionservice.SourceSessionActivity{
			WorkspaceID: activity.WorkspaceID,
			SessionID:   activity.SessionID,
			Kind:        kind,
			ActivityID:  activity.ActivityID,
			OccurredAt:  occurredAt,
		},
	)
}

func (driver *sqliteConformanceDriver) CommitCanonicalSourceActivity(
	ctx context.Context,
	activity tuttimodeexecutionconformance.SourceSessionActivity,
	clientSubmitID string,
) error {
	occurredAt := activity.OccurredAt
	if occurredAt.IsZero() {
		occurredAt = driver.CurrentTime()
	}
	occurredAtUnixMS := occurredAt.UnixMilli()
	turnStartedAt := activity.TurnStartedAt
	if turnStartedAt.IsZero() {
		turnStartedAt = occurredAt
	}
	turn := &agentactivitybiz.TurnTransition{
		WorkspaceID:      activity.WorkspaceID,
		AgentSessionID:   activity.SessionID,
		TurnID:           activity.ActivityID,
		Origin:           agentactivitybiz.TurnOriginUserPrompt,
		Phase:            agentactivitybiz.TurnPhaseRunning,
		StartedAtUnixMS:  turnStartedAt.UnixMilli(),
		OccurredAtUnixMS: occurredAtUnixMS,
	}
	messages := []agentactivitybiz.MessageUpdate(nil)
	if activity.Kind == "agent_turn" {
		turn.Origin = agentactivitybiz.TurnOriginProviderInitiated
		turn.Phase = agentactivitybiz.TurnPhaseSettled
		turn.Outcome = agentactivitybiz.TurnOutcomeCompleted
		turn.SettledAtUnixMS = occurredAtUnixMS
	} else {
		if !activity.TurnStartedAt.IsZero() {
			if _, err := driver.store.ReportActivityState(
				ctx,
				agentactivitybiz.ActivityStateReport{
					Session: agentactivitybiz.SessionStateReport{
						WorkspaceID:    activity.WorkspaceID,
						AgentSessionID: activity.SessionID,
						Kind:           agentactivitybiz.SessionKindRoot,
						Origin:         "runtime", Provider: "codex",
						Status:           "working",
						OccurredAtUnixMS: turnStartedAt.UnixMilli(),
					},
					Turn: &agentactivitybiz.TurnTransition{
						WorkspaceID:      activity.WorkspaceID,
						AgentSessionID:   activity.SessionID,
						TurnID:           activity.ActivityID,
						Origin:           agentactivitybiz.TurnOriginUserPrompt,
						Phase:            agentactivitybiz.TurnPhaseRunning,
						StartedAtUnixMS:  turnStartedAt.UnixMilli(),
						OccurredAtUnixMS: turnStartedAt.UnixMilli(),
					},
				},
			); err != nil {
				return err
			}
		}
		messages = []agentactivitybiz.MessageUpdate{{
			MessageID: "user-submit:" + activity.ActivityID,
			TurnID:    activity.ActivityID,
			Role:      "user",
			Kind:      "text",
			Status:    "completed",
			Payload: map[string]any{
				"clientSubmitId": clientSubmitID,
				"text":           "canonical source activity",
			},
			OccurredAtUnixMS: occurredAtUnixMS,
		}}
	}
	_, err := driver.store.ReportActivityState(
		ctx,
		agentactivitybiz.ActivityStateReport{
			Session: agentactivitybiz.SessionStateReport{
				WorkspaceID:      activity.WorkspaceID,
				AgentSessionID:   activity.SessionID,
				Kind:             agentactivitybiz.SessionKindRoot,
				Origin:           "runtime",
				Provider:         "codex",
				Status:           "working",
				OccurredAtUnixMS: occurredAtUnixMS,
			},
			Turn:     turn,
			Messages: messages,
		},
	)
	return err
}

func (driver *sqliteConformanceDriver) CommitCanonicalSourceCancellation(
	ctx context.Context,
	workspaceID string,
	sourceSessionID string,
	turnID string,
) error {
	now := driver.CurrentTime()
	_, err := driver.store.ReportActivityState(
		ctx,
		agentactivitybiz.ActivityStateReport{
			Session: agentactivitybiz.SessionStateReport{
				WorkspaceID: workspaceID, AgentSessionID: sourceSessionID,
				Kind: agentactivitybiz.SessionKindRoot, Origin: "runtime",
				Provider: "codex", Status: "idle", OccurredAtUnixMS: now.UnixMilli(),
			},
			Turn: &agentactivitybiz.TurnTransition{
				WorkspaceID: workspaceID, AgentSessionID: sourceSessionID,
				TurnID: turnID, Origin: agentactivitybiz.TurnOriginUserPrompt,
				Phase: agentactivitybiz.TurnPhaseSettled, Outcome: agentactivitybiz.TurnOutcomeCanceled,
				StartedAtUnixMS: now.Add(-time.Second).UnixMilli(),
				SettledAtUnixMS: now.UnixMilli(), OccurredAtUnixMS: now.UnixMilli(),
			},
		},
	)
	return err
}

func (driver *sqliteConformanceDriver) RunWatchdog(
	ctx context.Context,
	workspaceID string,
	leaseOwner string,
) error {
	return driver.executions.RunWatchdog(ctx, workspaceID, leaseOwner)
}

func (driver *sqliteConformanceDriver) StartupRecoverWatchdog(
	ctx context.Context,
	workspaceID string,
	leaseOwner string,
) error {
	fresh := tuttimodeexecutionservice.Service{
		Store: driver.store, Wakes: driver.wakeStore,
		MainWakeTargets: driver.wakeTarget, ReviewerActivity: driver.store,
		Clock: driver.clock.Now,
	}
	return fresh.RunWatchdog(ctx, workspaceID, leaseOwner)
}

func (driver *sqliteConformanceDriver) SetReviewerActive(
	ctx context.Context,
	workspaceID string,
	issueID string,
	active bool,
) error {
	if !active {
		if err := driver.execWakeFixtureMutation(ctx, `
UPDATE workspace_tutti_goal_reviews
SET status = 'canceled', updated_at_unix_ms = ?
WHERE workspace_id = ? AND execution_id = (
  SELECT execution_id
  FROM workspace_tutti_executions
  WHERE workspace_id = ? AND issue_id = ?
)
  AND status IN ('prepared', 'dispatched')
`, driver.CurrentTime().UnixMilli(), workspaceID, workspaceID, issueID); err != nil {
			return err
		}
		found, err := driver.store.HasActiveTuttiModeReviewer(
			ctx, workspaceID, issueID,
		)
		if err != nil {
			return err
		}
		if found {
			return errors.New("goal-review fixture remained active")
		}
		return nil
	}
	if err := driver.execWakeFixtureMutation(ctx, `
INSERT INTO workspace_tutti_goal_reviews (
  workspace_id, execution_id, checkpoint_id, review_id,
  review_agent_target_id, review_session_id, review_turn_id,
  status, created_at_unix_ms, updated_at_unix_ms
)
SELECT e.workspace_id, e.execution_id, c.checkpoint_id,
       e.execution_id || ':review:test', 'review-agent-target', '', '',
       'prepared', ?, ?
FROM workspace_tutti_executions e
JOIN workspace_tutti_execution_checkpoints c
  ON c.workspace_id = e.workspace_id AND c.execution_id = e.execution_id
WHERE e.workspace_id = ? AND e.issue_id = ?
ORDER BY c.sequence DESC
LIMIT 1
ON CONFLICT(workspace_id, execution_id, review_id) DO UPDATE SET
  status = 'prepared', updated_at_unix_ms = excluded.updated_at_unix_ms
`, driver.CurrentTime().UnixMilli(), driver.CurrentTime().UnixMilli(),
		workspaceID, issueID); err != nil {
		return err
	}
	found, err := driver.store.HasActiveTuttiModeReviewer(
		ctx, workspaceID, issueID,
	)
	if err != nil {
		return err
	}
	if !found {
		return errors.New("goal-review fixture was not visible through reader")
	}
	return nil
}

func (driver *sqliteConformanceDriver) ReviewerActive(
	ctx context.Context,
	workspaceID string,
	issueID string,
) (bool, error) {
	return driver.store.HasActiveTuttiModeReviewer(ctx, workspaceID, issueID)
}

func (driver *sqliteConformanceDriver) execWakeFixtureMutation(
	ctx context.Context,
	query string,
	args ...any,
) error {
	db, err := sql.Open("sqlite", "file:"+driver.dbPath)
	if err != nil {
		return err
	}
	defer func() { _ = db.Close() }()
	_, err = db.ExecContext(ctx, query, args...)
	return err
}

func (driver *sqliteConformanceDriver) CurrentTime() time.Time {
	return driver.clock.Now()
}

func (driver *sqliteConformanceDriver) WakeDeliveryCallCount() int {
	driver.wakeTarget.mu.Lock()
	defer driver.wakeTarget.mu.Unlock()
	return len(driver.wakeTarget.deliveries)
}

func (driver *sqliteConformanceDriver) WakeDeliveries() []tuttimodeexecutionconformance.WakeDelivery {
	driver.wakeTarget.mu.Lock()
	defer driver.wakeTarget.mu.Unlock()
	return append([]tuttimodeexecutionconformance.WakeDelivery(nil), driver.wakeTarget.deliveries...)
}

func (driver *sqliteConformanceDriver) WakeDeliveryClientSubmitIDs() []string {
	deliveries := driver.WakeDeliveries()
	ids := make([]string, 0, len(deliveries))
	for _, delivery := range deliveries {
		ids = append(ids, delivery.ClientSubmitID)
	}
	return ids
}

func (driver *sqliteConformanceDriver) WakeDeliveryCanonicalTurnCount() int {
	driver.wakeTarget.mu.Lock()
	defer driver.wakeTarget.mu.Unlock()
	return len(driver.wakeTarget.canonicalByClientSubmit)
}

var _ tuttimodeexecutionservice.MainWakeTarget = (*recordingMainWakeTarget)(nil)
