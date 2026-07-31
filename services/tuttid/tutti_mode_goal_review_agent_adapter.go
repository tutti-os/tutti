package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	runtimeprep "github.com/tutti-os/tutti/packages/agent/runtimeprep"
	agentactivitybiz "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	executionbiz "github.com/tutti-os/tutti/services/tuttid/biz/tuttimodeexecution"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
	tuttimodeexecutionservice "github.com/tutti-os/tutti/services/tuttid/service/tuttimodeexecution"
)

const tuttiModeGoalReviewVerdictCapability = "tutti-goal-review.goal-review.verdict"

var tuttiModeReviewerAllowedCommandCapabilities = []string{
	"issue-manager.issue.get",
	"issue-manager.issue.task.list",
	"issue-manager.issue.task.get",
	"issue-manager.issue.task.run.list",
	"issue-manager.issue.task.run.get",
	tuttiModeGoalReviewVerdictCapability,
}

type tuttiModeReviewerSessionCreator interface {
	CreateWithResult(
		context.Context,
		string,
		agentservice.CreateSessionInput,
	) (agentservice.CreateSessionResult, error)
}

type tuttiModeReviewerAgentAdapter struct {
	Host     tuttiModeMainWakeHost
	Sessions tuttiModeReviewerSessionCreator
}

func (adapter tuttiModeReviewerAgentAdapter) ObserveReviewerSession(
	ctx context.Context,
	workspaceID string,
	sessionID string,
) (tuttimodeexecutionservice.ReviewerSessionObservation, error) {
	if adapter.Host == nil {
		return tuttimodeexecutionservice.ReviewerSessionObservation{},
			tuttimodeexecutionservice.ErrServiceUnavailable
	}
	result, err := adapter.Host.GetSession(ctx, agenthost.SessionRef{
		WorkspaceID: workspaceID, AgentSessionID: sessionID,
	})
	if err != nil {
		if errorsIsSessionNotFound(err) {
			return tuttimodeexecutionservice.ReviewerSessionObservation{}, nil
		}
		return tuttimodeexecutionservice.ReviewerSessionObservation{}, err
	}
	return tuttimodeexecutionservice.ReviewerSessionObservation{
		Busy: strings.TrimSpace(result.Canonical.ActiveTurnID) != "",
	}, nil
}

func (adapter tuttiModeReviewerAgentAdapter) SendReviewer(
	ctx context.Context,
	launch tuttimodeexecutionservice.ReviewerLaunch,
) (tuttimodeexecutionservice.ReviewerDelivery, error) {
	if adapter.Sessions == nil {
		return tuttimodeexecutionservice.ReviewerDelivery{},
			tuttimodeexecutionservice.ErrServiceUnavailable
	}
	if len(launch.Capabilities) != 1 ||
		strings.TrimSpace(launch.Capabilities[0]) != tuttiModeGoalReviewVerdictCapability {
		return tuttimodeexecutionservice.ReviewerDelivery{},
			fmt.Errorf("%w: reviewer capability scope is invalid",
				executionbiz.ErrReviewerVerdictRejected)
	}
	visible := false
	browserUse := false
	computerUse := false
	title := "Tutti Mode Goal Review"
	permissionModeID := "read-only"
	result, err := adapter.Sessions.CreateWithResult(
		ctx,
		strings.TrimSpace(launch.WorkspaceID),
		agentservice.CreateSessionInput{
			AgentSessionID: strings.TrimSpace(launch.SessionID),
			AgentTargetID:  strings.TrimSpace(launch.AgentTargetID),
			InitialContent: []agentservice.PromptContentBlock{{
				Type: "text", Text: launch.Prompt,
			}},
			ClientSubmitID: strings.TrimSpace(launch.ClientSubmitID),
			CapabilityRefs: []agentservice.CapabilityReference{{
				Capability: tuttiModeGoalReviewVerdictCapability,
				Source:     "tutti_mode_goal_review",
			}},
			CommandCapabilityProjection: &runtimeprep.CommandCapabilityProjection{
				AllowedIDs: append(
					[]string(nil),
					tuttiModeReviewerAllowedCommandCapabilities...,
				),
				IncludeIntegrationIDs: []string{
					tuttiModeGoalReviewVerdictCapability,
				},
			},
			Metadata: map[string]any{
				"tuttiModeGoalReview":        true,
				"tuttiModeGoalReviewIssueId": strings.TrimSpace(launch.IssueID),
			},
			AgentTools:           []string{"shell"},
			PermissionModeID:     &permissionModeID,
			StrictPermissionMode: true,
			BrowserUse:           &browserUse,
			ComputerUse:          &computerUse,
			Title:                &title,
			Visible:              &visible,
		},
	)
	if err != nil {
		return tuttimodeexecutionservice.ReviewerDelivery{}, err
	}
	turnID := strings.TrimSpace(result.TurnID)
	if turnID == "" {
		return tuttimodeexecutionservice.ReviewerDelivery{},
			fmt.Errorf("%w: reviewer launch returned no canonical Turn",
				agentservice.ErrSubmitDeliveryUnknown)
	}
	canonicalSessionID := strings.TrimSpace(result.Session.ID)
	if canonicalSessionID == "" {
		canonicalSessionID = strings.TrimSpace(launch.SessionID)
	}
	if canonicalSessionID != strings.TrimSpace(launch.SessionID) {
		return tuttimodeexecutionservice.ReviewerDelivery{},
			fmt.Errorf("%w: reviewer launch returned a different canonical Session",
				agentservice.ErrSubmitDeliveryUnknown)
	}
	return tuttimodeexecutionservice.ReviewerDelivery{
		CanonicalSessionID: canonicalSessionID,
		CanonicalTurnID:    turnID,
	}, nil
}

func (adapter tuttiModeReviewerAgentAdapter) ReadReviewer(
	ctx context.Context,
	launch tuttimodeexecutionservice.ReviewerLaunch,
) (tuttimodeexecutionservice.ReviewerDelivery, bool, error) {
	if adapter.Host == nil {
		return tuttimodeexecutionservice.ReviewerDelivery{}, false,
			tuttimodeexecutionservice.ErrServiceUnavailable
	}
	sessionID := strings.TrimSpace(launch.SessionID)
	turnID, found, err := adapter.Host.FindTurnByClientSubmitID(
		ctx,
		agenthost.SessionRef{
			WorkspaceID:    strings.TrimSpace(launch.WorkspaceID),
			AgentSessionID: sessionID,
		},
		strings.TrimSpace(launch.ClientSubmitID),
	)
	if err != nil || !found || strings.TrimSpace(turnID) == "" {
		return tuttimodeexecutionservice.ReviewerDelivery{}, false, err
	}
	turn, turnFound, err := adapter.Host.GetTurn(
		ctx,
		agenthost.SessionRef{
			WorkspaceID:    strings.TrimSpace(launch.WorkspaceID),
			AgentSessionID: sessionID,
		},
		strings.TrimSpace(turnID),
	)
	if err != nil {
		return tuttimodeexecutionservice.ReviewerDelivery{}, false, err
	}
	return tuttimodeexecutionservice.ReviewerDelivery{
		CanonicalSessionID: sessionID,
		CanonicalTurnID:    strings.TrimSpace(turnID),
		Settled: turnFound &&
			strings.TrimSpace(turn.Phase) == agentactivitybiz.TurnPhaseSettled,
	}, true, nil
}

type tuttiModeReviewerTurnSettler interface {
	SettleReviewerTurnWithoutVerdict(
		context.Context,
		string,
		string,
		string,
		string,
	) error
}

type tuttiModeReviewerTurnObserver struct {
	Settlements tuttiModeReviewerTurnSettler
}

func (observer tuttiModeReviewerTurnObserver) ObserveRootTurnSettled(
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
	err := observer.Settlements.SettleReviewerTurnWithoutVerdict(
		ctx, workspaceID, sessionID, turn.TurnID, "",
	)
	if err == nil ||
		errors.Is(err, executionbiz.ErrExecutionNotFound) ||
		errors.Is(err, executionbiz.ErrReviewerVerdictRejected) {
		return
	}
	slog.WarnContext(
		ctx,
		"observe Tutti mode reviewer Turn settlement failed",
		"event", "tutti_mode_execution.reviewer_turn_settlement_failed",
		"workspaceId", workspaceID,
		"agentSessionId", sessionID,
		"turnId", turn.TurnID,
		"error", err,
	)
}

var _ tuttimodeexecutionservice.ReviewerTarget = tuttiModeReviewerAgentAdapter{}
var _ agentservice.RootTurnObserver = tuttiModeReviewerTurnObserver{}
