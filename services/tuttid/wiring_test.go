package main

import (
	"context"
	"errors"
	"fmt"
	"testing"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	workspaceagentbiz "github.com/tutti-os/tutti/services/tuttid/biz/workspaceagent"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
	reporterservice "github.com/tutti-os/tutti/services/tuttid/service/reporter"
	workspaceservice "github.com/tutti-os/tutti/services/tuttid/service/workspace"
	workspaceagentservice "github.com/tutti-os/tutti/services/tuttid/service/workspaceagent"
	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

type fakeAnalyticsDebugEventStream struct{}

func (fakeAnalyticsDebugEventStream) PublishFromServer(context.Context, string, []byte) error {
	return nil
}

func TestResolveAnalyticsDebugPublisherAllowsProductionAnalyticsDebugStream(t *testing.T) {
	got := resolveAnalyticsDebugPublisher(tuttitypes.AnalyticsConfig{
		AppID:         20004092,
		AppKey:        "app-key",
		ChannelDomain: "https://example.test",
	}, fakeAnalyticsDebugEventStream{})

	if _, ok := got.(analyticsDebugEventPublisher); !ok {
		t.Fatalf("debug publisher = %T, want analyticsDebugEventPublisher", got)
	}
}

func TestResolveAnalyticsDebugPublisherSkipsDisabledAnalytics(t *testing.T) {
	got := resolveAnalyticsDebugPublisher(tuttitypes.AnalyticsConfig{
		Disabled:      true,
		AppID:         20004092,
		AppKey:        "app-key",
		ChannelDomain: "https://example.test",
	}, fakeAnalyticsDebugEventStream{})

	if got != nil {
		t.Fatalf("debug publisher = %T, want nil", got)
	}
}

func TestTuttiModeWakeRecoveryStartsOnlyFromListenerReadyHook(t *testing.T) {
	calls := 0
	wiring := &tuttiWiring{
		tuttiModeWakeRecoveryStarter: func() {
			calls++
		},
	}
	if calls != 0 {
		t.Fatalf("wake recovery started during wiring construction: calls=%d", calls)
	}

	wiring.startTuttiModeWakeRecovery()
	if calls != 1 {
		t.Fatalf("listener-ready wake recovery calls=%d, want 1", calls)
	}
	wiring.startTuttiModeWakeRecovery()
	if calls != 1 {
		t.Fatalf("listener-ready wake recovery replay calls=%d, want one-shot", calls)
	}
}

type recordingWorkspaceAgentTargetResolverSetter struct {
	resolver agentservice.WorkspaceAgentTargetResolver
}

func (r *recordingWorkspaceAgentTargetResolverSetter) SetWorkspaceAgentTargetResolver(
	resolver agentservice.WorkspaceAgentTargetResolver,
) {
	r.resolver = resolver
}

type fakeWorkspaceAgentTargetResolver struct{}

func (fakeWorkspaceAgentTargetResolver) GetWorkspaceAgent(
	context.Context,
	string,
	string,
) (workspaceagentbiz.Agent, error) {
	return workspaceagentbiz.Agent{}, nil
}

func TestConfigureWorkspaceAgentResolutionWiresLaunchAndProjection(t *testing.T) {
	agentSessions := &agentservice.Service{}
	activityProjection := &recordingWorkspaceAgentTargetResolverSetter{}
	workspaceAgents := &workspaceagentservice.Service{}
	workspaceAgentTargets := fakeWorkspaceAgentTargetResolver{}

	configureWorkspaceAgentResolution(
		agentSessions,
		activityProjection,
		workspaceAgents,
		workspaceAgentTargets,
	)

	if agentSessions.WorkspaceAgentResolver != workspaceAgents {
		t.Fatalf(
			"agent session WorkspaceAgentResolver = %T, want workspace agent service",
			agentSessions.WorkspaceAgentResolver,
		)
	}
	if activityProjection.resolver != workspaceAgentTargets {
		t.Fatalf(
			"activity projection WorkspaceAgentTargetResolver = %T, want workspace agent service",
			activityProjection.resolver,
		)
	}
}

var _ reporterservice.DebugPublisher = analyticsDebugEventPublisher{}

type recordingIssueRunSessionCreator struct {
	workspaceID string
	input       agentservice.CreateSessionInput
	result      agentservice.CreateSessionResult
	err         error
	createCalls int
	legacyCalls int
}

type recordingIssueRunTurnFinder struct {
	turnID         string
	found          bool
	err            error
	calls          int
	ref            agenthost.SessionRef
	clientSubmitID string
}

func (finder *recordingIssueRunTurnFinder) FindTurnByClientSubmitID(
	_ context.Context,
	ref agenthost.SessionRef,
	clientSubmitID string,
) (string, bool, error) {
	finder.calls++
	finder.ref = ref
	finder.clientSubmitID = clientSubmitID
	return finder.turnID, finder.found, finder.err
}

func (creator *recordingIssueRunSessionCreator) Create(
	_ context.Context,
	workspaceID string,
	input agentservice.CreateSessionInput,
) (agentservice.Session, error) {
	creator.legacyCalls++
	creator.workspaceID = workspaceID
	creator.input = input
	return creator.result.Session, creator.err
}

func (creator *recordingIssueRunSessionCreator) CreateWithResult(
	_ context.Context,
	workspaceID string,
	input agentservice.CreateSessionInput,
) (agentservice.CreateSessionResult, error) {
	creator.createCalls++
	creator.workspaceID = workspaceID
	creator.input = input
	return creator.result, creator.err
}

func TestIssueRunAgentLauncherUsesPersistedClientSubmitID(t *testing.T) {
	creator := &recordingIssueRunSessionCreator{}
	err := (issueRunAgentLauncher{Sessions: creator}).Launch(
		context.Background(),
		workspaceservice.IssueRunLaunch{
			WorkspaceID: "workspace-1", RunID: "run-1",
			ClientSubmitID: "persisted-submit-id", AgentSessionID: "session-1",
			AgentTargetID: "local:codex", Title: "Task",
		},
	)
	if err != nil {
		t.Fatalf("Launch() error = %v", err)
	}
	if creator.workspaceID != "workspace-1" ||
		creator.input.ClientSubmitID != "persisted-submit-id" {
		t.Fatalf("Create() scope/input = %q/%#v", creator.workspaceID, creator.input)
	}
}

func TestIssueRunAgentLauncherClassifiesPreTurnFailureAsNotStarted(t *testing.T) {
	cause := errors.New("provider rejected launch")
	creator := &recordingIssueRunSessionCreator{err: cause}
	finder := &recordingIssueRunTurnFinder{}

	err := (issueRunAgentLauncher{Sessions: creator, Host: finder}).Launch(
		context.Background(),
		workspaceservice.IssueRunLaunch{
			WorkspaceID: "workspace-1", ClientSubmitID: "submit-1",
			AgentSessionID: "session-1", AgentTargetID: "local:codex", Title: "Task",
		},
	)

	if !errors.Is(err, cause) {
		t.Fatalf("Launch() error = %v, want wrapped cause %v", err, cause)
	}
	if err == cause || fmt.Sprintf("%T", err) != "workspace.issueRunLaunchNotStartedError" {
		t.Fatalf("Launch() error type = %T, want typed IssueRunLaunchNotStartedError", err)
	}
	if creator.createCalls != 1 || creator.legacyCalls != 0 {
		t.Fatalf(
			"session creation calls = CreateWithResult:%d Create:%d, want 1/0",
			creator.createCalls,
			creator.legacyCalls,
		)
	}
	if finder.calls != 1 ||
		finder.ref != (agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"}) ||
		finder.clientSubmitID != "submit-1" {
		t.Fatalf(
			"canonical Turn lookup = calls:%d ref:%#v submit:%q, want 1/workspace-1/session-1/submit-1",
			finder.calls,
			finder.ref,
			finder.clientSubmitID,
		)
	}
}

func TestIssueRunAgentLauncherKeepsDeliveryUnknownRecoverable(t *testing.T) {
	deliveryErr := fmt.Errorf("provider response lost: %w", agentservice.ErrSubmitDeliveryUnknown)
	creator := &recordingIssueRunSessionCreator{err: deliveryErr}
	finder := &recordingIssueRunTurnFinder{}

	err := (issueRunAgentLauncher{Sessions: creator, Host: finder}).Launch(
		context.Background(),
		workspaceservice.IssueRunLaunch{
			WorkspaceID: "workspace-1", ClientSubmitID: "submit-1",
			AgentSessionID: "session-1", AgentTargetID: "local:codex", Title: "Task",
		},
	)

	if err != deliveryErr {
		t.Fatalf("Launch() error = %v (%T), want unchanged ambiguous error", err, err)
	}
	if creator.createCalls != 1 || creator.legacyCalls != 0 {
		t.Fatalf(
			"session creation calls = CreateWithResult:%d Create:%d, want 1/0",
			creator.createCalls,
			creator.legacyCalls,
		)
	}
	if finder.calls != 0 {
		t.Fatalf("canonical Turn lookup calls = %d, want 0 for delivery-unknown", finder.calls)
	}
}

func TestIssueRunAgentLauncherKeepsTurnIdentifiedFailureRecoverable(t *testing.T) {
	cause := errors.New("response failed after canonical turn")
	creator := &recordingIssueRunSessionCreator{
		result: agentservice.CreateSessionResult{TurnID: "turn-1"},
		err:    cause,
	}
	finder := &recordingIssueRunTurnFinder{}

	err := (issueRunAgentLauncher{Sessions: creator, Host: finder}).Launch(
		context.Background(),
		workspaceservice.IssueRunLaunch{
			WorkspaceID: "workspace-1", ClientSubmitID: "submit-1",
			AgentSessionID: "session-1", AgentTargetID: "local:codex", Title: "Task",
		},
	)

	if err != cause {
		t.Fatalf("Launch() error = %v (%T), want unchanged recoverable error", err, err)
	}
	if creator.createCalls != 1 || creator.legacyCalls != 0 {
		t.Fatalf(
			"session creation calls = CreateWithResult:%d Create:%d, want 1/0",
			creator.createCalls,
			creator.legacyCalls,
		)
	}
	if finder.calls != 0 {
		t.Fatalf("canonical Turn lookup calls = %d, want 0 for identified Turn", finder.calls)
	}
}

func TestIssueRunAgentLauncherKeepsCanonicalTurnLookupHitRecoverable(t *testing.T) {
	cause := errors.New("submit claim read failed after canonical creation")
	creator := &recordingIssueRunSessionCreator{err: cause}
	finder := &recordingIssueRunTurnFinder{turnID: "turn-existing", found: true}

	err := (issueRunAgentLauncher{Sessions: creator, Host: finder}).Launch(
		context.Background(),
		workspaceservice.IssueRunLaunch{
			WorkspaceID: "workspace-1", ClientSubmitID: "submit-1",
			AgentSessionID: "session-1", AgentTargetID: "local:codex", Title: "Task",
		},
	)

	if err != cause {
		t.Fatalf("Launch() error = %v (%T), want unchanged recoverable error", err, err)
	}
	if finder.calls != 1 {
		t.Fatalf("canonical Turn lookup calls = %d, want 1", finder.calls)
	}
}

func TestIssueRunAgentLauncherKeepsCanonicalTurnLookupErrorRecoverable(t *testing.T) {
	cause := errors.New("submit claim read failed")
	lookupErr := errors.New("canonical store is temporarily unavailable")
	creator := &recordingIssueRunSessionCreator{err: cause}
	finder := &recordingIssueRunTurnFinder{err: lookupErr}

	err := (issueRunAgentLauncher{Sessions: creator, Host: finder}).Launch(
		context.Background(),
		workspaceservice.IssueRunLaunch{
			WorkspaceID: "workspace-1", ClientSubmitID: "submit-1",
			AgentSessionID: "session-1", AgentTargetID: "local:codex", Title: "Task",
		},
	)

	if err != cause {
		t.Fatalf("Launch() error = %v (%T), want unchanged recoverable error", err, err)
	}
	if finder.calls != 1 {
		t.Fatalf("canonical Turn lookup calls = %d, want 1", finder.calls)
	}
}
