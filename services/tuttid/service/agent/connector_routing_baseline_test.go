package agent

import (
	"context"
	"testing"

	runtimeprep "github.com/tutti-os/tutti/packages/agent/runtimeprep"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
)

func TestSendInputInjectsConnectorRoutingUpdateWhenIndexDiverges(t *testing.T) {
	runtime := newFakeRuntime()
	service := newTestService(runtime)
	service.SubmitClaimStore = openAgentServiceSQLiteStore(t)
	service.RuntimePreparer = fakeRuntimePreparer{result: runtimeprep.PreparedRuntime{Cwd: t.TempDir()}}
	connector := &testConnectorRuntime{
		hints: []runtimeprep.ConnectorRoutingHint{{ConnectorKey: "lark-cli", DisplayName: "Lark CLI", Aliases: []string{"飞书"}}},
		context: runtimeprep.ConnectorAgentContext{MCPServers: []runtimeprep.MCPServerBinding{{
			Name: "connector", Type: "http", URL: "http://127.0.0.1:1234/mcp/connector",
		}}},
	}
	service.ConnectorRuntime = connector
	service.ConnectorCapabilities = &testConnectorCapabilityResolver{supported: true}

	if _, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentSessionID: "11111111-1111-4111-8111-111111111111",
		AgentTargetID:  agenttargetbiz.IDLocalCodex,
		Provider:       "codex",
		InitialContent: TextPromptContent("hello"),
	}); err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if len(runtime.execCalls) != 1 || runtime.execCalls[0].ConnectorRoutingUpdate != nil {
		t.Fatalf("create exec calls = %#v, want one call without routing update", runtime.execCalls)
	}

	if _, err := service.SendInput(context.Background(), "ws-1", "11111111-1111-4111-8111-111111111111", SendInput{
		Content: TextPromptContent("first"),
	}); err != nil {
		t.Fatalf("SendInput() with unchanged index error = %v", err)
	}
	if len(runtime.execCalls) != 2 || runtime.execCalls[1].ConnectorRoutingUpdate != nil {
		t.Fatalf("unchanged index exec = %#v, want no routing update", runtime.execCalls[1].ConnectorRoutingUpdate)
	}

	connector.hints = append(connector.hints, runtimeprep.ConnectorRoutingHint{ConnectorKey: "github", DisplayName: "GitHub"})
	if _, err := service.SendInput(context.Background(), "ws-1", "11111111-1111-4111-8111-111111111111", SendInput{
		Content: TextPromptContent("second"),
	}); err != nil {
		t.Fatalf("SendInput() with diverged index error = %v", err)
	}
	update := runtime.execCalls[2].ConnectorRoutingUpdate
	if update == nil || *update != runtimeprep.ConnectorRoutingIndex(connector.hints) {
		t.Fatalf("routing update = %#v, want current index", update)
	}

	if _, err := service.SendInput(context.Background(), "ws-1", "11111111-1111-4111-8111-111111111111", SendInput{
		Content: TextPromptContent("third"),
	}); err != nil {
		t.Fatalf("SendInput() after committed baseline error = %v", err)
	}
	if runtime.execCalls[3].ConnectorRoutingUpdate != nil {
		t.Fatalf("committed baseline exec routing update = %#v, want nil", runtime.execCalls[3].ConnectorRoutingUpdate)
	}
}

func TestSendInputSkipsConnectorRoutingUpdateForGuidanceAndUntrackedSessions(t *testing.T) {
	runtime := newFakeRuntime()
	service := newIsolatedAgentService(runtime)
	service.SubmitClaimStore = openAgentServiceSQLiteStore(t)
	connector := &testConnectorRuntime{
		hints: []runtimeprep.ConnectorRoutingHint{{ConnectorKey: "github", DisplayName: "GitHub"}},
	}
	service.ConnectorRuntime = connector
	activeTurnID := "turn-1"
	runtime.sessions["ws-1:session-guidance"] = ProviderRuntimeSession{
		ID: "session-guidance", WorkspaceID: "ws-1", Provider: "codex", Status: "ready", Visible: true,
		TurnLifecycle: &TurnLifecycle{ActiveTurnID: &activeTurnID, Phase: "running"},
	}
	runtime.sessions["ws-1:session-untracked"] = ProviderRuntimeSession{
		ID: "session-untracked", WorkspaceID: "ws-1", Provider: "codex", Status: "ready", Visible: true,
	}

	// Guidance turns never carry a routing update even when the index diverged.
	service.connectorRoutingBaselines.record("ws-1", "session-guidance", "stale-index")
	if _, err := service.SendInput(context.Background(), "ws-1", "session-guidance", SendInput{
		Content: TextPromptContent("steer"), Guidance: true, TurnID: activeTurnID, ClientSubmitID: "submit-guidance",
	}); err != nil {
		t.Fatalf("guidance SendInput() error = %v", err)
	}
	if len(runtime.execCalls) != 1 || runtime.execCalls[0].ConnectorRoutingUpdate != nil {
		t.Fatalf("guidance exec = %#v, want no routing update", runtime.execCalls)
	}

	// Sessions prepared without Connector enhancement have no baseline and
	// must not receive an update pointing at unavailable discovery commands.
	if _, err := service.SendInput(context.Background(), "ws-1", "session-untracked", SendInput{
		Content: TextPromptContent("hello"),
	}); err != nil {
		t.Fatalf("untracked SendInput() error = %v", err)
	}
	if len(runtime.execCalls) != 2 || runtime.execCalls[1].ConnectorRoutingUpdate != nil {
		t.Fatalf("untracked exec = %#v, want no routing update", runtime.execCalls)
	}
}

func TestCleanupSessionResourcesClearsConnectorRoutingBaseline(t *testing.T) {
	service := newTestService(newFakeRuntime())
	service.RuntimePreparer = nil
	connector := &testConnectorRuntime{
		hints: []runtimeprep.ConnectorRoutingHint{{ConnectorKey: "github", DisplayName: "GitHub"}},
	}
	service.ConnectorRuntime = connector
	service.connectorRoutingBaselines.record("ws-1", "session-1", "stale-index")

	if err := service.cleanupSessionResources(t.Context(), "ws-1", "session-1"); err != nil {
		t.Fatalf("cleanupSessionResources() error = %v", err)
	}
	if update, changed := service.pendingConnectorRoutingUpdate("ws-1", "session-1"); changed {
		t.Fatalf("pending routing update after cleanup = %q, want untracked", update)
	}
}
