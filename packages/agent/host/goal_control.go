package agenthost

import (
	"context"
	"errors"
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
	if _, err := h.EnsureRuntimeSession(ctx, SessionRef{WorkspaceID: workspaceID, AgentSessionID: agentSessionID}); err != nil {
		slog.Warn("workspace agent session goal control prepare failed",
			"event", "workspace_agent_session.goal_control.prepare_failed",
			"workspaceId", workspaceID,
			"agentSessionId", agentSessionID,
			"error", err.Error(),
		)
		return GoalControlResult{}, err
	}
	operationID := ""
	goalRevision := int64(0)
	clientSubmitID := metadataString(submissionMetadata, "clientSubmitId")
	var persistedState *storesqlite.SessionGoalState
	if h.goals != nil {
		operationID = uuid.NewString()
		err := h.withGoalActor(ctx, workspaceID, agentSessionID, func(actorCtx context.Context) error {
			now := h.goalOperationNow()
			op, state, _, err := h.goals.PrepareGoalControlOperation(actorCtx, storesqlite.GoalControlOperationPrepare{
				OperationID: operationID, WorkspaceID: workspaceID, AgentSessionID: agentSessionID,
				Action: strings.TrimSpace(action), Objective: strings.TrimSpace(objective), ClientSubmitID: clientSubmitID,
				OccurredAtUnixMS: now.UnixMilli(),
			})
			if err != nil {
				return err
			}
			goalRevision = op.GoalRevision
			persistedState = &state
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
			return GoalControlResult{}, err
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
			cancel()
			if persistErr != nil {
				return GoalControlResult{}, errors.Join(normalizedErr, persistErr)
			}
		}
		slog.Warn("workspace agent session goal control runtime request failed",
			"event", "workspace_agent_session.goal_control.runtime_failed",
			"workspaceId", workspaceID,
			"agentSessionId", agentSessionID,
			"action", action,
			"error", normalizedErr.Error(),
		)
		return GoalControlResult{}, normalizedErr
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
				})
				persistedState = &state
				return err
			}
			_, state, _, err := h.goals.CompleteGoalControlOperation(actorCtx, storesqlite.GoalControlOperationComplete{
				WorkspaceID: workspaceID, OperationID: operationID, Succeeded: true,
				Observed: clonePayload(controlResult.Goal), Evidence: clonePayload(controlResult.Evidence),
				OccurredAtUnixMS: h.goalOperationNow().UnixMilli(),
			})
			persistedState = &state
			return err
		})
		cancel()
		if persistErr != nil {
			return GoalControlResult{}, persistErr
		}
	}
	canonical, found, err := h.store.GetSession(ctx, workspaceID, agentSessionID)
	if err != nil {
		slog.Warn("workspace agent session goal control refresh failed",
			"event", "workspace_agent_session.goal_control.refresh_failed",
			"workspaceId", workspaceID,
			"agentSessionId", agentSessionID,
			"error", err.Error(),
		)
		return GoalControlResult{}, err
	}
	if !found {
		return GoalControlResult{}, ErrSessionNotFound
	}
	slog.Info("workspace agent session goal control completed",
		"event", "workspace_agent_session.goal_control.completed",
		"workspaceId", workspaceID,
		"agentSessionId", agentSessionID,
		"action", action,
	)
	return GoalControlResult{Canonical: canonical, Goal: responseGoal, OperationID: operationID, GoalState: persistedState}, nil
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
