package agent

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"unicode"

	"github.com/google/uuid"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

type typedGoalControl struct {
	Action    string
	Objective string
}

func (s *Service) goalOperationOwner() string {
	owner := strings.TrimSpace(s.GoalOperationOwner)
	if owner == "" {
		owner = strings.TrimSpace(s.RuntimeOperationOwner)
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

func durableGoalForResponse(state agentactivitybiz.SessionGoalState) map[string]any {
	if state.Tombstoned {
		return nil
	}
	return clonePayload(state.Desired)
}

// parseTypedGoalControl recognizes the text-only slash surface at the service
// boundary. It intentionally runs before submit-claim allocation so typed and
// dedicated controls share one durable saga and no Turn contract is opened.
func parseTypedGoalControl(content []PromptContentBlock, _ string, guidance bool) (typedGoalControl, bool) {
	if guidance || len(content) != 1 || strings.TrimSpace(content[0].Type) != "text" {
		return typedGoalControl{}, false
	}
	// Content is the semantic command carrier. DisplayPrompt is presentation
	// only and must not be able to turn ordinary content into control, or hide
	// a real control command from the durable saga.
	prompt := strings.TrimSpace(content[0].Text)
	separator := strings.IndexFunc(prompt, unicode.IsSpace)
	if separator < 0 {
		return typedGoalControl{}, false
	}
	command, args := prompt[:separator], strings.TrimSpace(prompt[separator:])
	if !strings.EqualFold(strings.TrimSpace(command), "/goal") {
		return typedGoalControl{}, false
	}
	args = strings.TrimSpace(args)
	if args == "" {
		return typedGoalControl{}, false
	}
	switch strings.ToLower(args) {
	case "clear", "reset":
		return typedGoalControl{Action: "clear"}, true
	case "pause":
		return typedGoalControl{Action: "pause"}, true
	case "resume", "active":
		return typedGoalControl{Action: "resume"}, true
	default:
		return typedGoalControl{Action: "set", Objective: args}, true
	}
}

type GoalStateStore interface {
	PrepareGoalControlOperation(context.Context, agentactivitybiz.GoalControlOperationPrepare) (agentactivitybiz.GoalControlOperation, agentactivitybiz.SessionGoalState, bool, error)
	GetGoalControlAudit(context.Context, string, string, string) (agentactivitybiz.Message, bool, error)
	MarkGoalControlOperationDispatched(context.Context, string, string, int64) (agentactivitybiz.GoalControlOperation, bool, error)
	AcknowledgeGoalControlOperation(context.Context, agentactivitybiz.GoalControlOperationAcknowledge) (agentactivitybiz.GoalControlOperation, agentactivitybiz.SessionGoalState, bool, error)
	CompleteGoalControlOperation(context.Context, agentactivitybiz.GoalControlOperationComplete) (agentactivitybiz.GoalControlOperation, agentactivitybiz.SessionGoalState, bool, error)
	GetSessionGoalState(context.Context, string, string) (agentactivitybiz.SessionGoalState, bool, error)
	ReconcileSessionGoalObservation(context.Context, agentactivitybiz.GoalObservationReconcile) (agentactivitybiz.SessionGoalState, error)
	MarkGoalRevisionTerminalIncident(context.Context, agentactivitybiz.GoalTerminalIncidentInput) (agentactivitybiz.SessionGoalState, error)
	GetGoalControlOperation(context.Context, string, string) (agentactivitybiz.GoalControlOperation, bool, error)
	ListClaimableGoalControlOperations(context.Context, agentactivitybiz.ListClaimableGoalControlOperationsInput) ([]agentactivitybiz.GoalControlOperation, error)
	ClaimGoalControlOperation(context.Context, agentactivitybiz.ClaimGoalControlOperationInput) (agentactivitybiz.GoalControlOperation, bool, error)
	ReleaseGoalControlOperation(context.Context, agentactivitybiz.ReleaseGoalControlOperationInput) (agentactivitybiz.GoalControlOperation, bool, error)
	RecordGoalControlOperationEvidence(context.Context, agentactivitybiz.GoalControlOperationEvidence) (agentactivitybiz.GoalControlOperation, bool, error)
	EnsureOrWakeGoalRepairOperation(context.Context, agentactivitybiz.EnsureGoalRepairOperationInput) (agentactivitybiz.GoalControlOperation, agentactivitybiz.SessionGoalState, bool, error)
	RequeueLeasedGoalControlOperationsOnStartup(context.Context, int64) (int64, error)
}

// GoalControlSessionResult carries the refreshed session plus the goal
// snapshot after a goal control action (nil after clear).
type GoalControlSessionResult struct {
	Session     Session
	Goal        map[string]any
	OperationID string
	GoalState   *agentactivitybiz.SessionGoalState
}

// GoalControl performs a direct goal action (pause/resume/clear/set) on the
// session's thread. Like Cancel it is a control operation: it never opens a
// turn, so it works while a turn is running.
func (s *Service) GoalControl(ctx context.Context, workspaceID string, agentSessionID string, action string, objective string) (GoalControlSessionResult, error) {
	return s.goalControl(ctx, workspaceID, agentSessionID, action, objective, nil)
}

func (s *Service) goalControl(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
	action string,
	objective string,
	submissionMetadata map[string]any,
) (GoalControlSessionResult, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	slog.Info("workspace agent session goal control requested",
		"event", "workspace_agent_session.goal_control.requested",
		"workspaceId", workspaceID,
		"agentSessionId", agentSessionID,
		"action", action,
	)
	if _, err := s.ensureRuntimeSessionResult(ctx, workspaceID, agentSessionID); err != nil {
		slog.Warn("workspace agent session goal control prepare failed",
			"event", "workspace_agent_session.goal_control.prepare_failed",
			"workspaceId", workspaceID,
			"agentSessionId", agentSessionID,
			"error", err.Error(),
		)
		return GoalControlSessionResult{}, err
	}
	operationID := ""
	goalRevision := int64(0)
	clientSubmitID := metadataString(submissionMetadata, "clientSubmitId")
	var persistedState *agentactivitybiz.SessionGoalState
	if s.GoalStateStore != nil {
		operationID = uuid.NewString()
		err := s.withGoalActor(ctx, workspaceID, agentSessionID, func(actorCtx context.Context) error {
			now := s.goalOperationNow()
			op, state, created, err := s.GoalStateStore.PrepareGoalControlOperation(actorCtx, agentactivitybiz.GoalControlOperationPrepare{
				OperationID: operationID, WorkspaceID: workspaceID, AgentSessionID: agentSessionID,
				Action: strings.TrimSpace(action), Objective: strings.TrimSpace(objective), ClientSubmitID: clientSubmitID,
				OccurredAtUnixMS: now.UnixMilli(),
			})
			if err != nil {
				return err
			}
			goalRevision = op.GoalRevision
			persistedState = &state
			if created && s.GoalAuditPublisher != nil {
				audit, found, auditErr := s.GoalStateStore.GetGoalControlAudit(actorCtx, workspaceID, agentSessionID, operationID)
				if auditErr != nil {
					return auditErr
				}
				if !found {
					return errors.New("durable goal control audit disappeared after prepare")
				}
				s.GoalAuditPublisher.PublishGoalControlAudit(actorCtx, workspaceID, agentSessionID, audit)
			}
			owner := s.goalOperationOwner()
			if _, claimed, err := s.GoalStateStore.ClaimGoalControlOperation(actorCtx, agentactivitybiz.ClaimGoalControlOperationInput{
				WorkspaceID: workspaceID, OperationID: operationID, LeaseOwner: owner,
				NowUnixMS: now.UnixMilli(), LeaseExpiresAtMS: now.Add(goalOperationLeaseDuration).UnixMilli(),
			}); err != nil || !claimed {
				if err != nil {
					return err
				}
				return ErrRuntimeOperationInProgress
			}
			current, found, err := s.GoalStateStore.GetSessionGoalState(actorCtx, workspaceID, agentSessionID)
			if err != nil || !found || current.Revision != goalRevision || current.PendingOperationID != operationID {
				if err != nil {
					return err
				}
				return ErrRuntimeOperationInProgress
			}
			_, _, err = s.GoalStateStore.MarkGoalControlOperationDispatched(actorCtx, workspaceID, operationID, s.goalOperationNow().UnixMilli())
			return err
		})
		if err != nil {
			return GoalControlSessionResult{}, err
		}
	}
	controlResult, err := s.controller().GoalControl(ctx, RuntimeGoalControlInput{
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
		normalizedErr := normalizeRuntimeError(err)
		if s.GoalStateStore != nil && operationID != "" {
			persistCtx, cancel := goalPersistenceContext()
			persistErr := s.withGoalActor(persistCtx, workspaceID, agentSessionID, func(actorCtx context.Context) error {
				now := s.goalOperationNow()
				current, found, currentErr := s.GoalStateStore.GetSessionGoalState(actorCtx, workspaceID, agentSessionID)
				if currentErr != nil {
					return currentErr
				}
				if found && current.Revision > goalRevision {
					_, repairErr := s.ensureStaleGoalRepair(actorCtx, current, operationID, goalRevision,
						staleGoalResultEvidence(map[string]any{"error": normalizedErr.Error(), "ambiguous": true}, goalRevision, current.Revision),
						agentactivitybiz.GoalProviderPhaseUnknown)
					return repairErr
				}
				fail := !isRetryableRuntimeOperationError(normalizedErr)
				_, _, releaseErr := s.GoalStateStore.ReleaseGoalControlOperation(actorCtx, agentactivitybiz.ReleaseGoalControlOperationInput{
					WorkspaceID: workspaceID, OperationID: operationID, LeaseOwner: s.goalOperationOwner(),
					ProviderPhase: agentactivitybiz.GoalProviderPhaseDispatched, LastError: normalizedErr.Error(),
					NowUnixMS: now.UnixMilli(), NextAttemptAtMS: runtimeOperationNextAttemptAt(now, 1, fail), Fail: fail,
				})
				return releaseErr
			})
			cancel()
			if persistErr != nil {
				return GoalControlSessionResult{}, errors.Join(normalizedErr, persistErr)
			}
		}
		slog.Warn("workspace agent session goal control runtime request failed",
			"event", "workspace_agent_session.goal_control.runtime_failed",
			"workspaceId", workspaceID,
			"agentSessionId", agentSessionID,
			"action", action,
			"error", normalizedErr.Error(),
		)
		return GoalControlSessionResult{}, normalizedErr
	}
	responseGoal := clonePayload(controlResult.Goal)
	if s.GoalStateStore != nil && operationID != "" {
		persistCtx, cancel := goalPersistenceContext()
		persistErr := s.withGoalActor(persistCtx, workspaceID, agentSessionID, func(actorCtx context.Context) error {
			current, found, err := s.GoalStateStore.GetSessionGoalState(actorCtx, workspaceID, agentSessionID)
			if err != nil {
				return err
			}
			if !found {
				return errors.New("durable goal state disappeared after provider result")
			}
			if current.Revision > goalRevision {
				latest, err := s.ensureStaleGoalRepair(actorCtx, current, operationID, goalRevision,
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
				_, state, _, err := s.GoalStateStore.AcknowledgeGoalControlOperation(actorCtx, agentactivitybiz.GoalControlOperationAcknowledge{
					WorkspaceID: workspaceID, OperationID: operationID,
					Evidence: clonePayload(controlResult.Evidence), OccurredAtUnixMS: s.goalOperationNow().UnixMilli(),
				})
				persistedState = &state
				return err
			}
			_, state, _, err := s.GoalStateStore.CompleteGoalControlOperation(actorCtx, agentactivitybiz.GoalControlOperationComplete{
				WorkspaceID: workspaceID, OperationID: operationID, Succeeded: true,
				Observed: clonePayload(controlResult.Goal), Evidence: clonePayload(controlResult.Evidence),
				OccurredAtUnixMS: s.goalOperationNow().UnixMilli(),
			})
			persistedState = &state
			return err
		})
		cancel()
		if persistErr != nil {
			return GoalControlSessionResult{}, persistErr
		}
	}
	session, err := s.Get(ctx, workspaceID, agentSessionID)
	if err != nil {
		slog.Warn("workspace agent session goal control refresh failed",
			"event", "workspace_agent_session.goal_control.refresh_failed",
			"workspaceId", workspaceID,
			"agentSessionId", agentSessionID,
			"error", err.Error(),
		)
		return GoalControlSessionResult{}, err
	}
	slog.Info("workspace agent session goal control completed",
		"event", "workspace_agent_session.goal_control.completed",
		"workspaceId", workspaceID,
		"agentSessionId", agentSessionID,
		"action", action,
	)
	return GoalControlSessionResult{Session: session, Goal: responseGoal, OperationID: operationID, GoalState: persistedState}, nil
}

func goalControlSubmissionMetadata(clientSubmitID string) map[string]any {
	clientSubmitID = strings.TrimSpace(clientSubmitID)
	if clientSubmitID == "" {
		return nil
	}
	return map[string]any{"clientSubmitId": clientSubmitID}
}

func (s *Service) ensureStaleGoalRepair(ctx context.Context, current agentactivitybiz.SessionGoalState,
	sourceOperationID string, sourceRevision int64, evidence map[string]any, providerPhase string,
) (agentactivitybiz.SessionGoalState, error) {
	now := s.goalOperationNow().UnixMilli()
	if _, _, err := s.GoalStateStore.RecordGoalControlOperationEvidence(ctx, agentactivitybiz.GoalControlOperationEvidence{
		WorkspaceID: current.WorkspaceID, OperationID: sourceOperationID, ProviderPhase: providerPhase,
		Evidence: evidence, OccurredAtUnixMS: now,
	}); err != nil {
		return agentactivitybiz.SessionGoalState{}, err
	}
	for attempt := 0; attempt < 4; attempt++ {
		_, attached, _, err := s.GoalStateStore.EnsureOrWakeGoalRepairOperation(ctx, agentactivitybiz.EnsureGoalRepairOperationInput{
			WorkspaceID: current.WorkspaceID, AgentSessionID: current.AgentSessionID,
			SourceOperationID: sourceOperationID, SourceRevision: sourceRevision,
			CurrentRevision: current.Revision, OccurredAtUnixMS: now,
		})
		if err == nil {
			return attached, nil
		}
		if !errors.Is(err, agentactivitybiz.ErrGoalReconcileConflict) {
			return agentactivitybiz.SessionGoalState{}, err
		}
		latest, found, readErr := s.GoalStateStore.GetSessionGoalState(ctx, current.WorkspaceID, current.AgentSessionID)
		if readErr != nil || !found {
			return agentactivitybiz.SessionGoalState{}, readErr
		}
		if latest.Revision <= sourceRevision {
			return latest, nil
		}
		current = latest
	}
	return agentactivitybiz.SessionGoalState{}, agentactivitybiz.ErrGoalReconcileConflict
}
