package main

import (
	"context"
	"testing"

	workspaceagentbiz "github.com/tutti-os/tutti/services/tuttid/biz/workspaceagent"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
	reporterservice "github.com/tutti-os/tutti/services/tuttid/service/reporter"
	workspaceservice "github.com/tutti-os/tutti/services/tuttid/service/workspace"
	workspaceagentservice "github.com/tutti-os/tutti/services/tuttid/service/workspaceagent"
	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

type recordingIssueRunAgentSessionCreator struct {
	workspaceID string
	input       agentservice.CreateSessionInput
}

func (r *recordingIssueRunAgentSessionCreator) Create(
	_ context.Context,
	workspaceID string,
	input agentservice.CreateSessionInput,
) (agentservice.Session, error) {
	r.workspaceID = workspaceID
	r.input = input
	return agentservice.Session{}, nil
}

func TestIssueRunAgentLauncherForwardsSourceRailPlacement(t *testing.T) {
	creator := &recordingIssueRunAgentSessionCreator{}
	launcher := issueRunAgentLauncher{Sessions: creator}

	err := launcher.Launch(context.Background(), workspaceservice.IssueRunLaunch{
		WorkspaceID:        "workspace-1",
		AgentSessionID:     "delegate-1",
		AgentTargetID:      "local-codex",
		RunID:              "run-1",
		Title:              "Delegated task",
		Prompt:             "Implement the task",
		ExecutionDirectory: "/tmp/task-worktree",
		RailPlacement: &workspaceservice.IssueRunRailPlacement{
			Kind:        " project ",
			ProjectPath: " /workspace/project ",
			SectionKey:  " project:/workspace/project ",
		},
	})
	if err != nil {
		t.Fatalf("Launch() error = %v", err)
	}
	if creator.workspaceID != "workspace-1" {
		t.Fatalf("Create() workspace = %q, want workspace-1", creator.workspaceID)
	}
	if creator.input.Cwd == nil || *creator.input.Cwd != "/tmp/task-worktree" {
		t.Fatalf("Create() cwd = %#v, want isolated worktree", creator.input.Cwd)
	}
	if creator.input.RailPlacement == nil {
		t.Fatal("Create() rail placement is nil")
	}
	if creator.input.RailPlacement.Version != 1 ||
		creator.input.RailPlacement.Kind != "project" ||
		creator.input.RailPlacement.ProjectPath != "/workspace/project" ||
		creator.input.RailPlacement.SectionKey != "project:/workspace/project" {
		t.Fatalf("Create() rail placement = %#v", creator.input.RailPlacement)
	}
}

type fakeIssueSourceSessionReader struct {
	session agentservice.PersistedSession
	found   bool
}

func (r fakeIssueSourceSessionReader) GetSession(string, string) (agentservice.PersistedSession, bool) {
	return r.session, r.found
}

func (fakeIssueSourceSessionReader) ListSessions(string) ([]agentservice.PersistedSession, bool) {
	return nil, false
}

func (fakeIssueSourceSessionReader) SessionDeleted(context.Context, string, string) (bool, error) {
	return false, nil
}

func TestIssueSourceSessionContextResolverReturnsExecutionAndRailIdentity(t *testing.T) {
	resolver := issueSourceSessionContextResolver{Sessions: fakeIssueSourceSessionReader{
		found: true,
		session: agentservice.PersistedSession{
			Cwd:             " /workspace/project ",
			RailSectionKind: " project ",
			RailProjectPath: " /workspace/project ",
			RailSectionKey:  " project:/workspace/project ",
		},
	}}

	got, ok := resolver.ResolveSourceSessionContext("workspace-1", "planning-session")
	if !ok {
		t.Fatal("ResolveSourceSessionContext() found = false")
	}
	if got.WorkingDirectory != "/workspace/project" {
		t.Fatalf("working directory = %q, want /workspace/project", got.WorkingDirectory)
	}
	if got.RailPlacement == nil ||
		got.RailPlacement.Kind != "project" ||
		got.RailPlacement.ProjectPath != "/workspace/project" ||
		got.RailPlacement.SectionKey != "project:/workspace/project" {
		t.Fatalf("rail placement = %#v", got.RailPlacement)
	}
}

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
