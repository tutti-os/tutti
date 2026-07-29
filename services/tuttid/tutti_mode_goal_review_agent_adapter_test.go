package main

import (
	"context"
	"errors"
	"reflect"
	"testing"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	agentstoresqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
	executionbiz "github.com/tutti-os/tutti/services/tuttid/biz/tuttimodeexecution"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
	tuttimodeexecutionservice "github.com/tutti-os/tutti/services/tuttid/service/tuttimodeexecution"
)

type recordingReviewerSessionCreator struct {
	workspaceID string
	input       agentservice.CreateSessionInput
	result      agentservice.CreateSessionResult
	err         error
}

func (creator *recordingReviewerSessionCreator) CreateWithResult(
	_ context.Context,
	workspaceID string,
	input agentservice.CreateSessionInput,
) (agentservice.CreateSessionResult, error) {
	creator.workspaceID = workspaceID
	creator.input = input
	return creator.result, creator.err
}

type reviewerAdapterHost struct {
	session agentstoresqlite.Session
	getErr  error
	turnID  string
	found   bool
	findErr error
}

func (host reviewerAdapterHost) GetSession(
	context.Context,
	agenthost.SessionRef,
) (agenthost.GetSessionResult, error) {
	return agenthost.GetSessionResult{Canonical: host.session}, host.getErr
}

func (host reviewerAdapterHost) FindTurnByClientSubmitID(
	context.Context,
	agenthost.SessionRef,
	string,
) (string, bool, error) {
	return host.turnID, host.found, host.findErr
}

func (reviewerAdapterHost) GetTurn(
	context.Context,
	agenthost.SessionRef,
	string,
) (agentstoresqlite.Turn, bool, error) {
	return agentstoresqlite.Turn{}, false, nil
}

func TestTuttiModeReviewerAdapterCreatesDedicatedVerdictOnlySession(t *testing.T) {
	creator := &recordingReviewerSessionCreator{
		result: agentservice.CreateSessionResult{TurnID: "review-turn-1"},
	}
	launch := tuttimodeexecutionservice.ReviewerLaunch{
		WorkspaceID: "workspace-1", IssueID: "issue-1",
		AgentTargetID:  "workspace-agent:reviewer",
		SessionID:      "review-session-1",
		ClientSubmitID: "tutti-goal-review:review-1",
		Prompt:         "Review exact evidence.",
		Capabilities: []string{
			"tutti-goal-review.goal-review.verdict",
		},
	}

	delivery, err := (tuttiModeReviewerAgentAdapter{
		Sessions: creator,
	}).SendReviewer(context.Background(), launch)
	if err != nil {
		t.Fatalf("SendReviewer() error = %v", err)
	}
	if delivery != (tuttimodeexecutionservice.ReviewerDelivery{
		CanonicalSessionID: "review-session-1",
		CanonicalTurnID:    "review-turn-1",
	}) {
		t.Fatalf("delivery = %#v", delivery)
	}
	if creator.workspaceID != launch.WorkspaceID ||
		creator.input.AgentSessionID != launch.SessionID ||
		creator.input.AgentTargetID != launch.AgentTargetID ||
		creator.input.ClientSubmitID != launch.ClientSubmitID {
		t.Fatalf("create scope/input = %q/%#v", creator.workspaceID, creator.input)
	}
	if !reflect.DeepEqual(creator.input.InitialContent, []agentservice.PromptContentBlock{{
		Type: "text", Text: launch.Prompt,
	}}) {
		t.Fatalf("initial content = %#v", creator.input.InitialContent)
	}
	if !reflect.DeepEqual(creator.input.CapabilityRefs, []agentservice.CapabilityReference{{
		Capability: "tutti-goal-review.goal-review.verdict",
		Source:     "tutti_mode_goal_review",
	}}) {
		t.Fatalf("capability refs = %#v", creator.input.CapabilityRefs)
	}
	if creator.input.CommandCapabilityProjection == nil ||
		!reflect.DeepEqual(
			creator.input.CommandCapabilityProjection.AllowedIDs,
			[]string{
				"issue-manager.issue.get",
				"issue-manager.issue.task.list",
				"issue-manager.issue.task.get",
				"issue-manager.issue.task.run.list",
				"issue-manager.issue.task.run.get",
				"tutti-goal-review.goal-review.verdict",
			},
		) ||
		!reflect.DeepEqual(
			creator.input.CommandCapabilityProjection.IncludeIntegrationIDs,
			[]string{"tutti-goal-review.goal-review.verdict"},
		) ||
		len(creator.input.CommandCapabilityProjection.ExcludeIDs) != 0 {
		t.Fatalf(
			"command capability projection = %#v",
			creator.input.CommandCapabilityProjection,
		)
	}
	if creator.input.PermissionModeID == nil ||
		*creator.input.PermissionModeID != "read-only" ||
		!creator.input.StrictPermissionMode ||
		creator.input.BrowserUse == nil || *creator.input.BrowserUse ||
		creator.input.ComputerUse == nil || *creator.input.ComputerUse ||
		!reflect.DeepEqual(creator.input.AgentTools, []string{"shell"}) {
		t.Fatalf("reviewer runtime authority = %#v", creator.input)
	}
	if creator.input.Visible == nil || *creator.input.Visible {
		t.Fatalf("Visible = %#v, want dedicated hidden reviewer Session", creator.input.Visible)
	}
	if creator.input.Metadata["tuttiModeGoalReview"] != true ||
		creator.input.Metadata["tuttiModeGoalReviewIssueId"] != launch.IssueID {
		t.Fatalf("metadata = %#v", creator.input.Metadata)
	}
}

func TestTuttiModeReviewerAdapterRecoversCanonicalTurnBySubmitIdentity(t *testing.T) {
	launch := tuttimodeexecutionservice.ReviewerLaunch{
		WorkspaceID: "workspace-1", SessionID: "review-session-1",
		ClientSubmitID: "tutti-goal-review:review-1",
	}
	delivery, found, err := (tuttiModeReviewerAgentAdapter{
		Host: reviewerAdapterHost{turnID: "review-turn-canonical", found: true},
	}).ReadReviewer(context.Background(), launch)
	if err != nil || !found {
		t.Fatalf("ReadReviewer() found/error = %v/%v", found, err)
	}
	if delivery.CanonicalSessionID != launch.SessionID ||
		delivery.CanonicalTurnID != "review-turn-canonical" {
		t.Fatalf("delivery = %#v", delivery)
	}
}

func TestTuttiModeReviewerAdapterObservesCanonicalBusyStateAndMissingSession(t *testing.T) {
	busy, err := (tuttiModeReviewerAgentAdapter{
		Host: reviewerAdapterHost{session: agentstoresqlite.Session{
			ID: "review-session-1", ActiveTurnID: "review-turn-1",
		}},
	}).ObserveReviewerSession(
		context.Background(), "workspace-1", "review-session-1",
	)
	if err != nil || !busy.Busy {
		t.Fatalf("busy observation/error = %#v/%v", busy, err)
	}

	absent, err := (tuttiModeReviewerAgentAdapter{
		Host: reviewerAdapterHost{
			getErr: errors.Join(errors.New("wrapped"), agenthost.ErrSessionNotFound),
		},
	}).ObserveReviewerSession(
		context.Background(), "workspace-1", "review-session-2",
	)
	if err != nil || absent.Busy {
		t.Fatalf("absent observation/error = %#v/%v", absent, err)
	}
}

type recordingReviewerTurnSettler struct {
	workspaceID string
	sessionID   string
	turnID      string
	calls       int
	err         error
}

func (settler *recordingReviewerTurnSettler) SettleReviewerTurnWithoutVerdict(
	_ context.Context,
	workspaceID string,
	sessionID string,
	turnID string,
	_ string,
) error {
	settler.workspaceID = workspaceID
	settler.sessionID = sessionID
	settler.turnID = turnID
	settler.calls++
	return settler.err
}

func TestTuttiModeReviewerTurnObserverSettlesOnlyCanonicalSettledTurns(t *testing.T) {
	settler := &recordingReviewerTurnSettler{}
	observer := tuttiModeReviewerTurnObserver{Settlements: settler}
	observer.ObserveRootTurnSettled(
		context.Background(), "workspace-1", "review-session-1",
		agentactivitybiz.Turn{
			TurnID: "review-turn-1", Phase: agentactivitybiz.TurnPhaseSettled,
			SettledAtUnixMS: 1234,
		},
	)
	if settler.calls != 1 || settler.workspaceID != "workspace-1" ||
		settler.sessionID != "review-session-1" ||
		settler.turnID != "review-turn-1" {
		t.Fatalf("settlement = %#v", settler)
	}
	observer.ObserveRootTurnSettled(
		context.Background(), "workspace-1", "review-session-1",
		agentactivitybiz.Turn{
			TurnID: "review-turn-2", Phase: agentactivitybiz.TurnPhaseRunning,
		},
	)
	if settler.calls != 1 {
		t.Fatalf("non-settled reviewer Turn was observed: %#v", settler)
	}
}

func TestTuttiModeReviewerTurnObserverIgnoresUnrelatedSettledTurns(t *testing.T) {
	settler := &recordingReviewerTurnSettler{
		err: executionbiz.ErrExecutionNotFound,
	}
	(tuttiModeReviewerTurnObserver{Settlements: settler}).ObserveRootTurnSettled(
		context.Background(), "workspace-1", "unrelated-session",
		agentactivitybiz.Turn{
			TurnID: "turn-1", Phase: agentactivitybiz.TurnPhaseSettled,
			SettledAtUnixMS: 1234,
		},
	)
	if settler.calls != 1 {
		t.Fatalf("settlement calls = %d, want one harmless lookup", settler.calls)
	}
}
