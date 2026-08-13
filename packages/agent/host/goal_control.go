package agenthost

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"unicode"

	"github.com/google/uuid"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

type TypedGoalControl struct {
	Action    string
	Objective string
}

func normalizeTypedGoalControl(input TypedGoalControl) (TypedGoalControl, error) {
	action := strings.ToLower(strings.TrimSpace(input.Action))
	objective := strings.TrimSpace(input.Objective)
	switch action {
	case "set":
		if objective == "" {
			return TypedGoalControl{}, ErrInvalidArgument
		}
		return TypedGoalControl{Action: action, Objective: objective}, nil
	case "pause", "resume", "clear":
		if objective != "" {
			return TypedGoalControl{}, ErrInvalidArgument
		}
		return TypedGoalControl{Action: action}, nil
	default:
		return TypedGoalControl{}, ErrInvalidArgument
	}
}

func (h *Host) goalOperationOwner() string {
	owner := strings.TrimSpace(h.goalOwner)
	if owner == "" {
		owner = strings.TrimSpace(h.owner)
	}
	if owner == "" {
		owner = "goal-worker-local"
	}
	return owner
}

func staleGoalResultEvidence(evidence map[string]any, resultRevision, currentRevision int64) map[string]any {
	result := clonePayload(evidence)
	if result == nil {
		result = map[string]any{}
	}
	result["staleResult"] = true
	result["resultRevision"] = resultRevision
	result["currentRevision"] = currentRevision
	return result
}

func durableGoalForResponse(state storesqlite.SessionGoalState) map[string]any {
	if state.Tombstoned {
		return nil
	}
	return clonePayload(state.Desired)
}

func acceptedGoalControlResult(operationID string, state *storesqlite.SessionGoalState) GoalControlResult {
	result := GoalControlResult{OperationID: strings.TrimSpace(operationID)}
	if result.OperationID == "" || state == nil {
		return result
	}
	result.Goal = durableGoalForResponse(*state)
	result.GoalState = state
	result.IntentAccepted = true
	return result
}

func goalControlResultPending(result GoalControlResult) bool {
	if !result.IntentAccepted || result.GoalState == nil ||
		strings.TrimSpace(result.OperationID) == "" ||
		strings.TrimSpace(result.GoalState.PendingOperationID) != strings.TrimSpace(result.OperationID) {
		return false
	}
	switch strings.TrimSpace(result.GoalState.SyncStatus) {
	case storesqlite.GoalSyncStatusPending, storesqlite.GoalSyncStatusApplying:
		return true
	default:
		return false
	}
}

func goalControlOperationID(workspaceID, agentSessionID, clientSubmitID string) string {
	clientSubmitID = strings.TrimSpace(clientSubmitID)
	if clientSubmitID == "" {
		return uuid.NewString()
	}
	name := strings.Join([]string{
		strings.TrimSpace(workspaceID), strings.TrimSpace(agentSessionID), clientSubmitID,
	}, "\x00")
	return uuid.NewSHA1(uuid.NameSpaceURL, []byte(name)).String()
}

func goalControlClientSubmitID(input GoalControlInput, submissionMetadata map[string]any) string {
	if clientSubmitID := strings.TrimSpace(input.ClientSubmitID); clientSubmitID != "" {
		return clientSubmitID
	}
	return metadataString(submissionMetadata, "clientSubmitId")
}

// existingGoalControlResult resolves a durable replay before callers perform
// any provider-side setup. CreateSession uses it to keep a response-loss retry
// from starting a second provider Session after the Host process restarts.
func (h *Host) existingGoalControlResult(
	ctx context.Context,
	input GoalControlInput,
) (GoalControlResult, bool, error) {
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	agentSessionID := strings.TrimSpace(input.AgentSessionID)
	clientSubmitID := goalControlClientSubmitID(input, input.SubmissionMetadata)
	action := strings.TrimSpace(input.Action)
	objective := strings.TrimSpace(input.Objective)
	if h == nil || h.goals == nil || workspaceID == "" || agentSessionID == "" || clientSubmitID == "" {
		return GoalControlResult{}, false, nil
	}
	operationID := goalControlOperationID(workspaceID, agentSessionID, clientSubmitID)
	operation, found, err := h.goals.GetGoalControlOperation(ctx, workspaceID, operationID)
	if err != nil || !found {
		return GoalControlResult{}, false, err
	}
	if operation.AgentSessionID != agentSessionID ||
		operation.ClientSubmitID != clientSubmitID ||
		operation.Action != action ||
		operation.Objective != objective {
		return GoalControlResult{}, true, storesqlite.ErrGoalOperationConflict
	}
	state, stateFound, stateErr := h.goals.GetSessionGoalState(ctx, workspaceID, agentSessionID)
	if stateErr != nil {
		return GoalControlResult{}, true, stateErr
	}
	if !stateFound {
		return GoalControlResult{}, true, storesqlite.ErrGoalStateAbsent
	}
	accepted := acceptedGoalControlResult(operation.OperationID, &state)
	switch operation.Status {
	case storesqlite.GoalOperationStatusCompleted, storesqlite.GoalOperationStatusSuperseded:
		canonical, sessionFound, sessionErr := h.store.GetSession(ctx, workspaceID, agentSessionID)
		if sessionErr != nil {
			return accepted, true, sessionErr
		}
		if !sessionFound {
			return accepted, true, ErrSessionNotFound
		}
		accepted.Canonical = canonical
		return accepted, true, nil
	case storesqlite.GoalOperationStatusFailed:
		return accepted, true, fmt.Errorf(
			"%w: %s",
			ErrRuntimeOperationFailed,
			strings.TrimSpace(operation.LastError),
		)
	default:
		return accepted, true, ErrRuntimeOperationInProgress
	}
}

// ParseTypedGoalControl recognizes the text-only slash surface at the Host
// command boundary. It intentionally runs before submit-claim allocation so typed and
// dedicated controls share one durable saga and no Turn contract is opened.
func ParseTypedGoalControl(content []PromptContentBlock, guidance bool) (TypedGoalControl, bool) {
	if guidance || len(content) != 1 || strings.TrimSpace(content[0].Type) != "text" {
		return TypedGoalControl{}, false
	}
	// Content is the semantic command carrier. DisplayPrompt is presentation
	// only and must not be able to turn ordinary content into control, or hide
	// a real control command from the durable saga.
	prompt := strings.TrimSpace(content[0].Text)
	separator := strings.IndexFunc(prompt, unicode.IsSpace)
	if separator < 0 {
		return TypedGoalControl{}, false
	}
	command, args := prompt[:separator], strings.TrimSpace(prompt[separator:])
	if !strings.EqualFold(strings.TrimSpace(command), "/goal") {
		return TypedGoalControl{}, false
	}
	args = strings.TrimSpace(args)
	if args == "" {
		return TypedGoalControl{}, false
	}
	switch strings.ToLower(args) {
	case "clear", "reset":
		return TypedGoalControl{Action: "clear"}, true
	case "pause":
		return TypedGoalControl{Action: "pause"}, true
	case "resume", "active":
		return TypedGoalControl{Action: "resume"}, true
	default:
		return TypedGoalControl{Action: "set", Objective: args}, true
	}
}

func typedGoalDisplayPrompt(goal TypedGoalControl) string {
	if goal.Action == "set" {
		return firstNonEmpty("/goal "+strings.TrimSpace(goal.Objective), "")
	}
	return firstNonEmpty("/goal "+strings.TrimSpace(goal.Action), "")
}

func initialGoalRuntimeTitle(
	explicitTitle string,
	displayPrompt string,
	goal TypedGoalControl,
	isTypedGoal bool,
) (string, bool) {
	title := strings.TrimSpace(explicitTitle)
	if isTypedGoal && NormalizeTitle(title) == "" {
		title = DeriveInitialTitle(
			"",
			firstNonEmpty(strings.TrimSpace(displayPrompt), typedGoalDisplayPrompt(goal)),
		)
	}
	return title, NormalizeTitle(title) != ""
}

// GoalControl performs a direct goal action (pause/resume/clear/set) on the
// session's thread. Like Cancel it is a control operation: it never opens a
// turn, so it works while a turn is running.
func (h *Host) GoalControl(ctx context.Context, input GoalControlInput) (GoalControlResult, error) {
	return h.goalControl(ctx, input)
}

func (h *Host) goalControl(
	ctx context.Context,
	input GoalControlInput,
) (GoalControlResult, error) {
	if h == nil {
		return GoalControlResult{}, ErrInvalidArgument
	}
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	agentSessionID := strings.TrimSpace(input.AgentSessionID)
	if workspaceID == "" || agentSessionID == "" {
		return GoalControlResult{}, ErrInvalidArgument
	}
	var result GoalControlResult
	err := h.withSessionMutationActor(ctx, workspaceID, agentSessionID, func(actorCtx context.Context) error {
		var commandErr error
		result, commandErr = h.goalControlSerialized(actorCtx, input)
		return commandErr
	})
	return result, err
}

// goalControlSerialized keeps the provider mutation and its durable revision
// transition in one per-session command lane. A clear submitted immediately
// after set must reach the provider after set; revision repair alone cannot
// prevent the older provider call from temporarily resurrecting a goal.
func (h *Host) goalControlSerialized(
	ctx context.Context,
	input GoalControlInput,
) (GoalControlResult, error) {
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	agentSessionID := strings.TrimSpace(input.AgentSessionID)
	action := strings.TrimSpace(input.Action)
	objective := strings.TrimSpace(input.Objective)
	submissionMetadata := clonePayload(input.SubmissionMetadata)
	if h == nil || h.store == nil || h.runtime == nil || h.goalRuntime == nil || workspaceID == "" || agentSessionID == "" || action == "" {
		return GoalControlResult{}, ErrInvalidArgument
	}
	slog.Info("workspace agent session goal control requested",
		"event", "workspace_agent_session.goal_control.requested",
		"workspaceId", workspaceID,
		"agentSessionId", agentSessionID,
		"action", action,
	)
	operationID := ""
	goalRevision := int64(0)
	clientSubmitID := goalControlClientSubmitID(input, submissionMetadata)
	var persistedState *storesqlite.SessionGoalState
	replayed := false
	if h.goals != nil {
		operationID = goalControlOperationID(workspaceID, agentSessionID, clientSubmitID)
		err := h.withGoalActor(ctx, workspaceID, agentSessionID, func(actorCtx context.Context) error {
			now := h.goalOperationNow()
			op, state, created, err := h.goals.PrepareGoalControlOperation(actorCtx, storesqlite.GoalControlOperationPrepare{
				OperationID: operationID, WorkspaceID: workspaceID, AgentSessionID: agentSessionID,
				Action: strings.TrimSpace(action), Objective: strings.TrimSpace(objective), ClientSubmitID: clientSubmitID,
				ExpectedRevision: input.ExpectedRevision,
				OccurredAtUnixMS: now.UnixMilli(),
			})
			if err != nil {
				return err
			}
			goalRevision = op.GoalRevision
			persistedState = &state
			if !created {
				switch op.Status {
				case storesqlite.GoalOperationStatusCompleted, storesqlite.GoalOperationStatusSuperseded:
					replayed = true
					return nil
				case storesqlite.GoalOperationStatusFailed:
					return fmt.Errorf("%w: %s", ErrRuntimeOperationFailed, strings.TrimSpace(op.LastError))
				default:
					return ErrRuntimeOperationInProgress
				}
			}
			return nil
		})
		if err != nil {
			return acceptedGoalControlResult(operationID, persistedState), err
		}
	}
	if replayed {
		canonical, found, err := h.store.GetSession(ctx, workspaceID, agentSessionID)
		if err != nil {
			return GoalControlResult{}, err
		}
		if !found {
			return GoalControlResult{}, ErrSessionNotFound
		}
		return GoalControlResult{
			Canonical: canonical, Goal: durableGoalForResponse(*persistedState),
			OperationID: operationID, GoalState: persistedState,
			IntentAccepted: true,
		}, nil
	}
	if _, err := h.EnsureRuntimeSession(ctx, SessionRef{WorkspaceID: workspaceID, AgentSessionID: agentSessionID}); err != nil {
		slog.Warn("workspace agent session goal control prepare failed",
			"event", "workspace_agent_session.goal_control.prepare_failed",
			"workspaceId", workspaceID,
			"agentSessionId", agentSessionID,
			"error", err.Error(),
		)
		h.observeTerminalFailure(ctx, TerminalFailure{
			Flow:           "goal_control",
			FailureStage:   "prepare",
			WorkspaceID:    workspaceID,
			AgentSessionID: agentSessionID,
			OperationID:    operationID,
			ClientSubmitID: clientSubmitID,
			ErrorCode:      terminalFailureCode(err),
			ErrorMessage:   err.Error(),
			Retryable:      isRetryableRuntimeOperationError(err),
		})
		return acceptedGoalControlResult(operationID, persistedState), err
	}
	if h.goals != nil {
		err := h.withGoalActor(ctx, workspaceID, agentSessionID, func(actorCtx context.Context) error {
			now := h.goalOperationNow()
			owner := h.goalOperationOwner()
			if _, claimed, err := h.goals.ClaimGoalControlOperation(actorCtx, storesqlite.ClaimGoalControlOperationInput{
				WorkspaceID: workspaceID, OperationID: operationID, LeaseOwner: owner,
				NowUnixMS: now.UnixMilli(), LeaseExpiresAtMS: now.Add(goalOperationLeaseDuration).UnixMilli(),
			}); err != nil || !claimed {
				if err != nil {
					return err
				}
				return ErrRuntimeOperationInProgress
			}
			current, found, err := h.goals.GetSessionGoalState(actorCtx, workspaceID, agentSessionID)
			if err != nil || !found || current.Revision != goalRevision || current.PendingOperationID != operationID {
				if err != nil {
					return err
				}
				return ErrRuntimeOperationInProgress
			}
			_, _, err = h.goals.MarkGoalControlOperationDispatched(actorCtx, workspaceID, operationID, h.goalOperationNow().UnixMilli())
			return err
		})
		if err != nil {
			return acceptedGoalControlResult(operationID, persistedState), err
		}
	}
	controlResult, err := h.goalRuntime.GoalControl(ctx, RuntimeGoalControlInput{
		WorkspaceID:        workspaceID,
		AgentSessionID:     agentSessionID,
		Action:             action,
		Objective:          objective,
		OperationID:        operationID,
		GoalRevision:       goalRevision,
		RepairEpoch:        0,
		SubmissionMetadata: goalControlSubmissionMetadata(clientSubmitID),
	})
	if err != nil {
		normalizedErr := err
		if h.goals != nil && operationID != "" {
			persistCtx, cancel := goalPersistenceContext()
			persistErr := h.withGoalActor(persistCtx, workspaceID, agentSessionID, func(actorCtx context.Context) error {
				now := h.goalOperationNow()
				current, found, currentErr := h.goals.GetSessionGoalState(actorCtx, workspaceID, agentSessionID)
				if currentErr != nil {
					return currentErr
				}
				if found && current.Revision > goalRevision {
					_, repairErr := h.ensureStaleGoalRepair(actorCtx, current, operationID, goalRevision,
						staleGoalResultEvidence(map[string]any{"error": normalizedErr.Error(), "ambiguous": true}, goalRevision, current.Revision),
						storesqlite.GoalProviderPhaseUnknown)
					return repairErr
				}
				fail := !isRetryableRuntimeOperationError(normalizedErr)
				_, _, releaseErr := h.goals.ReleaseGoalControlOperation(actorCtx, storesqlite.ReleaseGoalControlOperationInput{
					WorkspaceID: workspaceID, OperationID: operationID, LeaseOwner: h.goalOperationOwner(),
					ProviderPhase: storesqlite.GoalProviderPhaseDispatched, LastError: normalizedErr.Error(),
					NowUnixMS: now.UnixMilli(), NextAttemptAtMS: runtimeOperationNextAttemptAt(now, 1, fail), Fail: fail,
				})
				return releaseErr
			})
			if latest, found, stateErr := h.goals.GetSessionGoalState(persistCtx, workspaceID, agentSessionID); stateErr == nil && found {
				persistedState = &latest
			}
			cancel()
			if persistErr != nil {
				return acceptedGoalControlResult(operationID, persistedState), errors.Join(normalizedErr, persistErr)
			}
		}
		slog.Warn("workspace agent session goal control runtime request failed",
			"event", "workspace_agent_session.goal_control.runtime_failed",
			"workspaceId", workspaceID,
			"agentSessionId", agentSessionID,
			"action", action,
			"error", normalizedErr.Error(),
		)
		return acceptedGoalControlResult(operationID, persistedState), normalizedErr
	}
	responseGoal := clonePayload(controlResult.Goal)
	if h.goals != nil && operationID != "" {
		persistCtx, cancel := goalPersistenceContext()
		persistErr := h.withGoalActor(persistCtx, workspaceID, agentSessionID, func(actorCtx context.Context) error {
			current, found, err := h.goals.GetSessionGoalState(actorCtx, workspaceID, agentSessionID)
			if err != nil {
				return err
			}
			if !found {
				return errors.New("durable goal state disappeared after provider result")
			}
			if current.Revision > goalRevision {
				latest, err := h.ensureStaleGoalRepair(actorCtx, current, operationID, goalRevision,
					staleGoalResultEvidence(controlResult.Evidence, goalRevision, current.Revision), controlResult.ProviderPhase)
				if err != nil {
					return err
				}
				persistedState = &latest
				responseGoal = durableGoalForResponse(latest)
				return nil
			}
			if current.Revision < goalRevision {
				return errors.New("durable goal revision regressed behind provider result")
			}
			if controlResult.ProviderPhase == "accepted" {
				_, state, _, err := h.goals.AcknowledgeGoalControlOperation(actorCtx, storesqlite.GoalControlOperationAcknowledge{
					WorkspaceID: workspaceID, OperationID: operationID,
					Evidence: clonePayload(controlResult.Evidence), OccurredAtUnixMS: h.goalOperationNow().UnixMilli(),
					ExecutionPending: controlResult.ExecutionPending,
				})
				persistedState = &state
				return err
			}
			_, state, _, err := h.goals.CompleteGoalControlOperation(actorCtx, storesqlite.GoalControlOperationComplete{
				WorkspaceID: workspaceID, OperationID: operationID, Succeeded: true,
				Observed: clonePayload(controlResult.Goal), Evidence: clonePayload(controlResult.Evidence),
				OccurredAtUnixMS: h.goalOperationNow().UnixMilli(),
				ExecutionPending: controlResult.ExecutionPending,
			})
			persistedState = &state
			return err
		})
		cancel()
		if persistErr != nil {
			return acceptedGoalControlResult(operationID, persistedState), persistErr
		}
	}
	if persistedState != nil {
		// GoalControlResult.Goal is the Host-owned durable projection used by
		// every consumer. Provider output remains available independently as
		// GoalState.Observed and may legitimately be empty while a pause or
		// resume is applied. Only a durable tombstone projects an explicit nil.
		responseGoal = durableGoalForResponse(*persistedState)
	}
	canonical, found, err := h.store.GetSession(ctx, workspaceID, agentSessionID)
	if err != nil {
		slog.Warn("workspace agent session goal control refresh failed",
			"event", "workspace_agent_session.goal_control.refresh_failed",
			"workspaceId", workspaceID,
			"agentSessionId", agentSessionID,
			"error", err.Error(),
		)
		h.observeTerminalFailure(ctx, TerminalFailure{
			Flow:           "goal_control",
			FailureStage:   "refresh",
			WorkspaceID:    workspaceID,
			AgentSessionID: agentSessionID,
			OperationID:    operationID,
			ClientSubmitID: clientSubmitID,
			ErrorCode:      terminalFailureCode(err),
			ErrorMessage:   err.Error(),
			Retryable:      isRetryableRuntimeOperationError(err),
		})
		return acceptedGoalControlResult(operationID, persistedState), err
	}
	if !found {
		return acceptedGoalControlResult(operationID, persistedState), ErrSessionNotFound
	}
	slog.Info("workspace agent session goal control completed",
		"event", "workspace_agent_session.goal_control.completed",
		"workspaceId", workspaceID,
		"agentSessionId", agentSessionID,
		"action", action,
	)
	return GoalControlResult{
		Canonical: canonical, Goal: responseGoal, OperationID: operationID,
		GoalState: persistedState, IntentAccepted: operationID != "" && persistedState != nil,
	}, nil
}

func goalControlSubmissionMetadata(clientSubmitID string) map[string]any {
	clientSubmitID = strings.TrimSpace(clientSubmitID)
	if clientSubmitID == "" {
		return nil
	}
	return map[string]any{"clientSubmitId": clientSubmitID}
}

func (h *Host) ensureStaleGoalRepair(ctx context.Context, current storesqlite.SessionGoalState,
	sourceOperationID string, sourceRevision int64, evidence map[string]any, providerPhase string,
) (storesqlite.SessionGoalState, error) {
	now := h.goalOperationNow().UnixMilli()
	if _, _, err := h.goals.RecordGoalControlOperationEvidence(ctx, storesqlite.GoalControlOperationEvidence{
		WorkspaceID: current.WorkspaceID, OperationID: sourceOperationID, ProviderPhase: providerPhase,
		Evidence: evidence, OccurredAtUnixMS: now,
	}); err != nil {
		return storesqlite.SessionGoalState{}, err
	}
	for attempt := 0; attempt < 4; attempt++ {
		_, attached, _, err := h.goals.EnsureOrWakeGoalRepairOperation(ctx, storesqlite.EnsureGoalRepairOperationInput{
			WorkspaceID: current.WorkspaceID, AgentSessionID: current.AgentSessionID,
			SourceOperationID: sourceOperationID, SourceRevision: sourceRevision,
			CurrentRevision: current.Revision, OccurredAtUnixMS: now,
		})
		if err == nil {
			return attached, nil
		}
		if !errors.Is(err, storesqlite.ErrGoalReconcileConflict) {
			return storesqlite.SessionGoalState{}, err
		}
		latest, found, readErr := h.goals.GetSessionGoalState(ctx, current.WorkspaceID, current.AgentSessionID)
		if readErr != nil || !found {
			return storesqlite.SessionGoalState{}, readErr
		}
		if latest.Revision <= sourceRevision {
			return latest, nil
		}
		current = latest
	}
	return storesqlite.SessionGoalState{}, storesqlite.ErrGoalReconcileConflict
}
