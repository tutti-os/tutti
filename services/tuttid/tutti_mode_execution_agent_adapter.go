package main

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync/atomic"
	"time"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	agentactivitybiz "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
	tuttimodeexecutionservice "github.com/tutti-os/tutti/services/tuttid/service/tuttimodeexecution"
	workspaceservice "github.com/tutti-os/tutti/services/tuttid/service/workspace"
)

type tuttiModeMainWakeHost interface {
	GetSession(context.Context, agenthost.SessionRef) (agenthost.GetSessionResult, error)
	FindTurnByClientSubmitID(context.Context, agenthost.SessionRef, string) (string, bool, error)
	GetTurn(context.Context, agenthost.SessionRef, string) (agentactivitybiz.Turn, bool, error)
}

type tuttiModeMainWakeAgentAdapter struct {
	Host     tuttiModeMainWakeHost
	Sessions *agentservice.Service
}

func (adapter tuttiModeMainWakeAgentAdapter) ObserveSourceSession(
	ctx context.Context,
	workspaceID string,
	sessionID string,
) (tuttimodeexecutionservice.SourceSessionObservation, error) {
	if adapter.Host == nil {
		return tuttimodeexecutionservice.SourceSessionObservation{}, nil
	}
	result, err := adapter.Host.GetSession(ctx, agenthost.SessionRef{
		WorkspaceID: workspaceID, AgentSessionID: sessionID,
	})
	if err != nil {
		if errorsIsSessionNotFound(err) {
			return tuttimodeexecutionservice.SourceSessionObservation{}, nil
		}
		return tuttimodeexecutionservice.SourceSessionObservation{}, err
	}
	return tuttimodeexecutionservice.SourceSessionObservation{
		Exists: strings.TrimSpace(result.Canonical.ID) == strings.TrimSpace(sessionID),
		Busy:   strings.TrimSpace(result.Canonical.ActiveTurnID) != "",
	}, nil
}

func (adapter tuttiModeMainWakeAgentAdapter) SendMainWake(
	ctx context.Context,
	workspaceID string,
	sessionID string,
	clientSubmitID string,
	prompt string,
) (tuttimodeexecutionservice.MainWakeDelivery, error) {
	if adapter.Sessions == nil {
		return tuttimodeexecutionservice.MainWakeDelivery{}, tuttimodeexecutionservice.ErrServiceUnavailable
	}
	result, err := adapter.Sessions.SendInput(ctx, workspaceID, sessionID, agentservice.SendInput{
		Content:        []agentservice.PromptContentBlock{{Type: "text", Text: prompt}},
		ClientSubmitID: clientSubmitID,
		Metadata: map[string]any{
			"tuttiModeExecutionWake": true,
		},
	})
	if err != nil {
		return tuttimodeexecutionservice.MainWakeDelivery{}, err
	}
	return tuttimodeexecutionservice.MainWakeDelivery{
		CanonicalSessionID: sessionID,
		CanonicalTurnID:    strings.TrimSpace(result.TurnID),
	}, nil
}

func (adapter tuttiModeMainWakeAgentAdapter) FindMainWakeTurn(
	ctx context.Context,
	workspaceID string,
	sessionID string,
	clientSubmitID string,
) (string, bool, error) {
	if adapter.Host == nil {
		return "", false, tuttimodeexecutionservice.ErrServiceUnavailable
	}
	return adapter.Host.FindTurnByClientSubmitID(ctx, agenthost.SessionRef{
		WorkspaceID: workspaceID, AgentSessionID: sessionID,
	}, clientSubmitID)
}

func (adapter tuttiModeMainWakeAgentAdapter) ReadMainWakeTurn(
	ctx context.Context,
	workspaceID string,
	sessionID string,
	clientSubmitID string,
) (tuttimodeexecutionservice.MainWakeTurnObservation, bool, error) {
	if adapter.Host == nil {
		return tuttimodeexecutionservice.MainWakeTurnObservation{},
			false, tuttimodeexecutionservice.ErrServiceUnavailable
	}
	ref := agenthost.SessionRef{
		WorkspaceID: workspaceID, AgentSessionID: sessionID,
	}
	turnID, found, err := adapter.Host.FindTurnByClientSubmitID(
		ctx, ref, clientSubmitID,
	)
	if err != nil || !found {
		return tuttimodeexecutionservice.MainWakeTurnObservation{}, false, err
	}
	turn, found, err := adapter.Host.GetTurn(ctx, ref, turnID)
	if err != nil || !found {
		return tuttimodeexecutionservice.MainWakeTurnObservation{}, false, err
	}
	observation := tuttimodeexecutionservice.MainWakeTurnObservation{
		CanonicalTurnID: strings.TrimSpace(turn.TurnID),
	}
	if strings.TrimSpace(turn.Phase) == agentactivitybiz.TurnPhaseSettled &&
		turn.SettledAtUnixMS > 0 {
		observation.SettledAt = time.UnixMilli(turn.SettledAtUnixMS).UTC()
	}
	return observation, observation.CanonicalTurnID != "", nil
}

// errorsIsSessionNotFound keeps the wake adapter independent of provider
// runtime errors: Host canonical absence is the only missing-source signal.
func errorsIsSessionNotFound(err error) bool {
	return errors.Is(err, agenthost.ErrSessionNotFound)
}

type rootTurnObserverFanout []agentservice.RootTurnObserver

func (observers rootTurnObserverFanout) ObserveRootTurnSettled(
	ctx context.Context,
	workspaceID string,
	sessionID string,
	turn agentactivitybiz.Turn,
) {
	for _, observer := range observers {
		if observer != nil {
			observer.ObserveRootTurnSettled(ctx, workspaceID, sessionID, turn)
		}
	}
}

type tuttiModeSourceActivityService interface {
	ObserveSourceSessionActivity(
		context.Context,
		tuttimodeexecutionservice.SourceSessionActivity,
	) error
}

type tuttiModeSourceActivityAdapter struct {
	Executions tuttiModeSourceActivityService
}

func (adapter tuttiModeSourceActivityAdapter) ObserveTuttiModeSourceActivity(
	ctx context.Context,
	activity agentservice.TuttiModeSourceActivity,
) error {
	if adapter.Executions == nil {
		return tuttimodeexecutionservice.ErrServiceUnavailable
	}
	return adapter.Executions.ObserveSourceSessionActivity(
		ctx,
		tuttimodeexecutionservice.SourceSessionActivity{
			WorkspaceID: activity.WorkspaceID,
			SessionID:   activity.SessionID,
			Kind: tuttimodeexecutionservice.SourceSessionActivityKind(
				activity.Kind,
			),
			ActivityID: activity.ActivityID,
			OccurredAt: time.UnixMilli(activity.OccurredAtUnixMS).UTC(),
		},
	)
}

type tuttiModeSourceTurnActivityObserver struct {
	Activities agentservice.TuttiModeSourceActivityObserver
}

func (observer tuttiModeSourceTurnActivityObserver) ObserveRootTurnSettled(
	ctx context.Context,
	workspaceID string,
	sessionID string,
	turn agentactivitybiz.Turn,
) {
	if observer.Activities == nil ||
		strings.TrimSpace(turn.Phase) != agentactivitybiz.TurnPhaseSettled ||
		strings.TrimSpace(turn.TurnID) == "" || turn.SettledAtUnixMS <= 0 {
		return
	}
	if err := observer.Activities.ObserveTuttiModeSourceActivity(
		ctx,
		agentservice.TuttiModeSourceActivity{
			WorkspaceID:      workspaceID,
			SessionID:        sessionID,
			Kind:             "agent_turn",
			ActivityID:       turn.TurnID,
			OccurredAtUnixMS: turn.SettledAtUnixMS,
		},
	); err != nil {
		slog.WarnContext(
			ctx,
			"observe Tutti mode source Agent Turn failed",
			"event", "tutti_mode_execution.source_agent_turn_observation_failed",
			"workspaceId", workspaceID,
			"agentSessionId", sessionID,
			"turnId", turn.TurnID,
			"error", err,
		)
	}
}

type tuttiModeMainWakeTurnSettler interface {
	ObserveMainWakeTurnSettledAt(context.Context, string, string, string, time.Time) error
}

type workspaceReconcileEnqueuer interface {
	Enqueue(string)
}

type tuttiModeMainWakeTurnObserver struct {
	Settlements tuttiModeMainWakeTurnSettler
	Queue       workspaceReconcileEnqueuer
}

func (observer tuttiModeMainWakeTurnObserver) ObserveRootTurnSettled(
	ctx context.Context,
	workspaceID string,
	sessionID string,
	turn agentactivitybiz.Turn,
) {
	if observer.Settlements == nil ||
		strings.TrimSpace(turn.Phase) != agentactivitybiz.TurnPhaseSettled ||
		strings.TrimSpace(turn.TurnID) == "" || turn.SettledAtUnixMS <= 0 {
		return
	}
	if err := observer.Settlements.ObserveMainWakeTurnSettledAt(
		ctx, workspaceID, sessionID, turn.TurnID,
		time.UnixMilli(turn.SettledAtUnixMS).UTC(),
	); err != nil {
		slog.WarnContext(ctx, "observe Tutti mode main wake Turn settlement failed",
			"event", "tutti_mode_execution.main_wake_turn_settlement_failed",
			"workspaceId", workspaceID,
			"agentSessionId", sessionID,
			"turnId", turn.TurnID,
			"error", err,
		)
	}
	if observer.Queue != nil {
		observer.Queue.Enqueue(workspaceID)
	}
}

type tuttiModeMainWakeStartupRecoverer interface {
	PrepareStartupMainWakeRecovery(context.Context, string) error
}

type tuttiModeMainWakeRecoverer interface {
	PrepareStartupMainWakeRecovery(context.Context, string) error
	RecoverMainWakes(context.Context, string, string) error
}

type tuttiModeMainWakeReadyRecovery struct {
	Delegate tuttiModeMainWakeRecoverer
	ready    atomic.Bool
}

func (recovery *tuttiModeMainWakeReadyRecovery) MarkReady() {
	if recovery != nil {
		recovery.ready.Store(true)
	}
}

func (recovery *tuttiModeMainWakeReadyRecovery) PrepareStartupMainWakeRecovery(
	ctx context.Context,
	workspaceID string,
) error {
	if recovery == nil || recovery.Delegate == nil {
		return tuttimodeexecutionservice.ErrServiceUnavailable
	}
	return recovery.Delegate.PrepareStartupMainWakeRecovery(ctx, workspaceID)
}

func (recovery *tuttiModeMainWakeReadyRecovery) RecoverMainWakes(
	ctx context.Context,
	workspaceID string,
	leaseOwner string,
) error {
	if recovery == nil || recovery.Delegate == nil {
		return tuttimodeexecutionservice.ErrServiceUnavailable
	}
	if !recovery.ready.Load() {
		return tuttimodeexecutionservice.ErrMainWakeDeliveryPending
	}
	return recovery.Delegate.RecoverMainWakes(ctx, workspaceID, leaseOwner)
}

func reconcileTuttiModeRunsAndMainWakes(
	ctx context.Context,
	workspaceID string,
	leaseOwner string,
	reconcileRuns func(context.Context, string) (workspaceservice.IssueRunReconcileResult, error),
	recoverWakes tuttiModeMainWakeRecoverer,
) (workspaceservice.IssueRunReconcileResult, error) {
	result, err := reconcileRuns(ctx, workspaceID)
	if err != nil {
		return result, err
	}
	if recoverWakes == nil {
		return result, nil
	}
	if err := recoverWakes.PrepareStartupMainWakeRecovery(
		ctx, workspaceID,
	); err != nil {
		return result, err
	}
	if err := recoverWakes.RecoverMainWakes(
		ctx, workspaceID, leaseOwner,
	); err != nil {
		return result, err
	}
	return result, nil
}

// repairTuttiModeMainWakesAtStartup is deliberately non-fatal. Durable wake
// recovery must not make one transient source-session or corrupt-operation
// failure prevent the daemon from serving every other workspace. This startup
// phase is local-only: Agent delivery is enqueued by the listener-ready hook.
func repairTuttiModeMainWakesAtStartup(
	ctx context.Context,
	recoverer tuttiModeMainWakeStartupRecoverer,
	workspaceID string,
) {
	if recoverer == nil {
		return
	}
	if err := recoverer.PrepareStartupMainWakeRecovery(
		ctx, workspaceID,
	); err != nil {
		slog.WarnContext(ctx, "recover Tutti mode main wakes at startup failed",
			"event", "tutti_mode_execution.main_wake_startup_recovery_failed",
			"workspaceId", workspaceID,
			"error", err,
		)
	}
}

var _ tuttimodeexecutionservice.MainWakeTarget = tuttiModeMainWakeAgentAdapter{}
var _ agentservice.TuttiModeSourceActivityObserver = tuttiModeSourceActivityAdapter{}
var _ agentservice.RootTurnObserver = rootTurnObserverFanout{}
var _ agentservice.RootTurnObserver = tuttiModeSourceTurnActivityObserver{}
var _ agentservice.RootTurnObserver = tuttiModeMainWakeTurnObserver{}
