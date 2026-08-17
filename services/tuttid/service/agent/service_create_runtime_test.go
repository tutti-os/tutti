package agent

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	runtimeprep "github.com/tutti-os/tutti/packages/agent/runtimeprep"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
)

type testConnectorRuntime struct {
	hints      []runtimeprep.ConnectorRoutingHint
	context    runtimeprep.ConnectorAgentContext
	bind       func(string, string)
	bindErr    error
	bindCalls  int
	revoked    []string
	revokeAlls int
}

func (runtime *testConnectorRuntime) RoutingHints() []runtimeprep.ConnectorRoutingHint {
	return runtime.hints
}

func (runtime *testConnectorRuntime) BindSession(workspaceID, sessionID string) (runtimeprep.ConnectorAgentContext, error) {
	runtime.bindCalls++
	if runtime.bind != nil {
		runtime.bind(workspaceID, sessionID)
	}
	context := runtime.context
	if len(context.RoutingHints) == 0 {
		context.RoutingHints = runtime.hints
	}
	return context, runtime.bindErr
}

type testConnectorCapabilityResolver struct {
	supported bool
	err       error
	calls     int
}

func (resolver *testConnectorCapabilityResolver) ConnectorHTTPMCPSupported(
	_ context.Context,
	_ ConnectorCapabilityInput,
) (bool, error) {
	resolver.calls++
	return resolver.supported, resolver.err
}

func (runtime *testConnectorRuntime) RevokeSession(workspaceID, sessionID string) {
	runtime.revoked = append(runtime.revoked, workspaceID+"/"+sessionID)
}

func (runtime *testConnectorRuntime) RevokeAll() {
	runtime.revokeAlls++
}

func TestServiceCreateUsesRuntimePreparerResult(t *testing.T) {
	runtime := newFakeRuntime()
	service := newTestService(runtime)
	var prepareInput runtimeprep.PrepareInput
	service.RuntimePreparer = fakeRuntimePreparer{
		result: runtimeprep.PreparedRuntime{
			Cwd: "/prepared/workdir",
			Env: []string{"CODEX_HOME=/prepared/codex-home"},
			MCPServers: []runtimeprep.MCPServerBinding{{Name: "connector", Type: "http", URL: "http://127.0.0.1:1234/mcp/connector",
				Headers: map[string]string{"Authorization": "Bearer session-token"}}},
		},
		input: &prepareInput,
	}
	routingAliases := []string{"飞书", "Feishu"}
	skillRoot := t.TempDir()
	service.ConnectorRuntime = &testConnectorRuntime{
		hints: []runtimeprep.ConnectorRoutingHint{{ConnectorKey: "lark-cli", DisplayName: "Lark CLI", Aliases: routingAliases,
			SkillRoot: skillRoot}},
		context: runtimeprep.ConnectorAgentContext{MCPServers: []runtimeprep.MCPServerBinding{{Name: "connector", Type: "http", URL: "http://127.0.0.1:1234/mcp/connector",
			Headers: map[string]string{"Authorization": "Bearer session-token"}}}},
		bind: func(workspaceID, sessionID string) {
			if workspaceID != "ws-1" || sessionID != "11111111-1111-4111-8111-111111111111" {
				t.Fatalf("connector MCP binding scope = %q %q", workspaceID, sessionID)
			}
		},
	}
	service.ConnectorCapabilities = &testConnectorCapabilityResolver{supported: true}
	cwd := "/user/workdir"

	session, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentSessionID:         "11111111-1111-4111-8111-111111111111",
		AgentTargetID:          agenttargetbiz.IDLocalCodex,
		Cwd:                    &cwd,
		Provider:               "codex",
		ConversationDetailMode: "general",
		InitialContent:         TextPromptContent("hello"),
	})
	if err != nil {
		t.Fatalf("Create returned error: %v", err)
	}
	if session.Cwd != "/prepared/workdir" {
		t.Fatalf("session cwd = %q, want prepared cwd", session.Cwd)
	}
	if len(runtime.startCalls) != 1 {
		t.Fatalf("start calls = %d, want 1", len(runtime.startCalls))
	}
	start := runtime.startCalls[0]
	if start.Cwd != "/prepared/workdir" {
		t.Fatalf("runtime cwd = %q, want prepared cwd", start.Cwd)
	}
	if got := envValue(start.Env, "CODEX_HOME"); got != "/prepared/codex-home" {
		t.Fatalf("runtime CODEX_HOME = %q, env=%#v", got, start.Env)
	}
	if got := envValue(start.Env, agenthost.AgentCWDEnvironmentVariable); got != "/prepared/workdir" {
		t.Fatalf("runtime caller cwd = %q, env=%#v", got, start.Env)
	}
	placement, parseErr := agenthost.ParseAgentRailPlacementEnvironment(
		envValue(start.Env, agenthost.AgentRailPlacementEnvironmentVariable),
	)
	if parseErr != nil || placement.Kind != agenthost.RailPlacementKindConversations {
		t.Fatalf("runtime rail placement = %#v error=%v, env=%#v", placement, parseErr, start.Env)
	}
	if len(start.MCPServers) != 1 || start.MCPServers[0].Name != "connector" || start.MCPServers[0].Headers["Authorization"] != "Bearer session-token" {
		t.Fatalf("runtime MCP servers = %#v", start.MCPServers)
	}
	if prepareInput.Connector == nil || len(prepareInput.Connector.MCPServers) != 1 || prepareInput.Connector.MCPServers[0].Name != "connector" {
		t.Fatalf("prepare Connector context = %#v", prepareInput.Connector)
	}
	if prepareInput.ConversationDetailMode != "general" {
		t.Fatalf("prepare conversationDetailMode = %q, want general", prepareInput.ConversationDetailMode)
	}
	if len(prepareInput.Connector.RoutingHints) != 1 || prepareInput.Connector.RoutingHints[0].ConnectorKey != "lark-cli" ||
		!slices.Equal(prepareInput.Connector.RoutingHints[0].Aliases, routingAliases) ||
		prepareInput.Connector.RoutingHints[0].SkillRoot != skillRoot {
		t.Fatalf("prepare connector routing hints = %#v", prepareInput.Connector.RoutingHints)
	}
	prepareInput.Connector.RoutingHints[0].Aliases[0] = "mutated"
	if got := service.activeConnectorRoutingHints()[0].Aliases[0]; got != "飞书" {
		t.Fatalf("runtime preparation leaked mutable routing aliases: %q", got)
	}
}

func TestPrepareRuntimeRevokesConnectorBindingWhenProviderPreparationFails(t *testing.T) {
	service := newTestService(newFakeRuntime())
	prepareErr := errors.New("prepare failed")
	preparer := &sequenceRuntimePreparer{results: []runtimeprep.PreparedRuntime{{Cwd: t.TempDir()}}, errors: []error{nil, prepareErr, nil}}
	service.RuntimePreparer = preparer
	connector := &testConnectorRuntime{context: runtimeprep.ConnectorAgentContext{MCPServers: []runtimeprep.MCPServerBinding{{
		Name: "connector", Type: "http", URL: "http://127.0.0.1:1234/mcp/connector",
	}}}}
	service.ConnectorRuntime = connector
	service.ConnectorCapabilities = &testConnectorCapabilityResolver{supported: true}

	_, err := service.prepareRuntimeWithModelEndpoint(t.Context(), "ws-1", t.TempDir(), CreateSessionInput{
		AgentSessionID: "11111111-1111-4111-8111-111111111111",
		Provider:       "codex",
	}, nil)
	if err != nil {
		t.Fatalf("prepareRuntimeWithModelEndpoint() error = %v, want ordinary runtime fallback", err)
	}
	if !slices.Equal(connector.revoked, []string{"ws-1/11111111-1111-4111-8111-111111111111"}) {
		t.Fatalf("revoked bindings = %#v", connector.revoked)
	}
}

type sequenceRuntimePreparer struct {
	results []runtimeprep.PreparedRuntime
	errors  []error
	inputs  []runtimeprep.PrepareInput
}

func (preparer *sequenceRuntimePreparer) Prepare(_ context.Context, input runtimeprep.PrepareInput) (runtimeprep.PreparedRuntime, error) {
	preparer.inputs = append(preparer.inputs, input)
	index := len(preparer.inputs) - 1
	var result runtimeprep.PreparedRuntime
	if index < len(preparer.results) {
		result = preparer.results[index]
	}
	if index < len(preparer.errors) {
		return result, preparer.errors[index]
	}
	return result, nil
}

func (*sequenceRuntimePreparer) Cleanup(context.Context, runtimeprep.CleanupInput) error { return nil }

func TestPrepareRuntimeSkipsConnectorWhenAgentDoesNotDeclareHTTPMCP(t *testing.T) {
	service := newTestService(newFakeRuntime())
	var prepareInput runtimeprep.PrepareInput
	service.RuntimePreparer = fakeRuntimePreparer{result: runtimeprep.PreparedRuntime{Cwd: t.TempDir()}, input: &prepareInput}
	connector := &testConnectorRuntime{}
	service.ConnectorRuntime = connector
	service.ConnectorCapabilities = &testConnectorCapabilityResolver{supported: false}

	prepared, err := service.prepareRuntimeWithModelEndpoint(t.Context(), "ws-1", t.TempDir(), CreateSessionInput{
		AgentSessionID: "11111111-1111-4111-8111-111111111111", Provider: "acp:future-agent",
	}, nil)
	if err != nil {
		t.Fatalf("prepareRuntimeWithModelEndpoint() error = %v", err)
	}
	if connector.bindCalls != 0 || prepareInput.Connector != nil || len(prepared.MCPServers) != 0 {
		t.Fatalf("unsupported Agent received Connector: binds=%d input=%#v MCP=%#v", connector.bindCalls, prepareInput.Connector, prepared.MCPServers)
	}
}

func TestPrepareRuntimeContinuesWithoutConnectorWhenProbeFails(t *testing.T) {
	service := newTestService(newFakeRuntime())
	service.RuntimePreparer = fakeRuntimePreparer{result: runtimeprep.PreparedRuntime{Cwd: t.TempDir()}}
	connector := &testConnectorRuntime{}
	service.ConnectorRuntime = connector
	service.ConnectorCapabilities = &testConnectorCapabilityResolver{err: errors.New("probe failed")}

	if _, err := service.prepareRuntimeWithModelEndpoint(t.Context(), "ws-1", t.TempDir(), CreateSessionInput{
		AgentSessionID: "11111111-1111-4111-8111-111111111111", Provider: "acp:future-agent",
	}, nil); err != nil {
		t.Fatalf("prepareRuntimeWithModelEndpoint() error = %v", err)
	}
	if connector.bindCalls != 0 {
		t.Fatalf("Connector BindSession calls = %d, want 0", connector.bindCalls)
	}
}

func TestPrepareRuntimeContinuesWithoutConnectorWhenBindingFails(t *testing.T) {
	service := newTestService(newFakeRuntime())
	service.RuntimePreparer = fakeRuntimePreparer{result: runtimeprep.PreparedRuntime{Cwd: t.TempDir()}}
	connector := &testConnectorRuntime{bindErr: errors.New("binding failed")}
	service.ConnectorRuntime = connector
	service.ConnectorCapabilities = &testConnectorCapabilityResolver{supported: true}

	prepared, err := service.prepareRuntimeWithModelEndpoint(t.Context(), "ws-1", t.TempDir(), CreateSessionInput{
		AgentSessionID: "11111111-1111-4111-8111-111111111111", Provider: "acp:future-agent",
	}, nil)
	if err != nil {
		t.Fatalf("prepareRuntimeWithModelEndpoint() error = %v", err)
	}
	if connector.bindCalls != 1 || len(prepared.MCPServers) != 0 {
		t.Fatalf("binding fallback = calls %d MCP %#v", connector.bindCalls, prepared.MCPServers)
	}
}

func TestCleanupSessionResourcesRevokesConnectorWithoutProviderPreparer(t *testing.T) {
	service := newTestService(newFakeRuntime())
	service.RuntimePreparer = nil
	connector := &testConnectorRuntime{}
	service.ConnectorRuntime = connector

	if err := service.cleanupSessionResources(t.Context(), "ws-1", "session-1"); err != nil {
		t.Fatalf("cleanupSessionResources() error = %v", err)
	}
	if !slices.Equal(connector.revoked, []string{"ws-1/session-1"}) {
		t.Fatalf("revoked bindings = %#v", connector.revoked)
	}
}

func TestServiceCreateRejectsInvalidCatalogModelBeforePreparingRuntime(t *testing.T) {
	runtime := newFakeRuntime()
	service := newTestService(runtime)
	service.ModelCatalog = fakeModelCatalog{
		result: AgentModelCatalogResult{
			Provider: "codex",
			Source:   "codex-cli",
			Models: []AgentModelOption{
				{
					ID:                         "gpt-5",
					DisplayName:                "GPT-5",
					DefaultReasoningEffort:     "minimal",
					ReasoningEffortsAdvertised: true,
					SupportedReasoningEfforts: []AgentModelReasoningEffortOption{
						{Value: "minimal"},
						{Value: "high"},
					},
				},
				{ID: "gpt-5.1", DisplayName: "GPT-5.1"},
			},
		},
	}
	var prepareInput runtimeprep.PrepareInput
	service.RuntimePreparer = fakeRuntimePreparer{
		input: &prepareInput,
	}

	_, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentTargetID: agenttargetbiz.IDLocalCodex,
		Provider:      "codex",
		Model:         stringRef("gpt-6"),
		Cwd:           stringRef("/repo"),
	})
	if err == nil {
		t.Fatal("Create returned nil error, want invalid model error")
	}
	var invalidModel *InvalidModelError
	if !errors.As(err, &invalidModel) {
		t.Fatalf("Create error = %T %[1]v, want InvalidModelError", err)
	}
	if invalidModel.Model != "gpt-6" || !slices.Equal(invalidModel.AvailableModels, []string{"gpt-5", "gpt-5.1"}) {
		t.Fatalf("invalid model error = %#v", invalidModel)
	}
	if len(runtime.startCalls) != 0 {
		t.Fatalf("start calls = %d, want 0", len(runtime.startCalls))
	}
	if prepareInput.Provider != "" {
		t.Fatalf("runtime preparer was called: %#v", prepareInput)
	}
}

func TestServiceCreateRejectsInvalidCachedClaudeModelBeforePreparingRuntime(t *testing.T) {
	runtime := newFakeRuntime()
	service := newTestService(runtime)
	service.setLiveComposerModelOptions("claude-code", "ws-1", "/repo", time.Now().UTC(), []ComposerConfigOptionValue{
		{Value: "default", Label: "Default"},
		{Value: "sonnet", Label: "Sonnet"},
	})
	var prepareInput runtimeprep.PrepareInput
	service.RuntimePreparer = fakeRuntimePreparer{
		input: &prepareInput,
	}

	_, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentTargetID: agenttargetbiz.IDLocalClaudeCode,
		Provider:      "claude-code",
		Model:         stringRef("not-a-claude-model"),
		Cwd:           stringRef("/repo"),
	})
	if err == nil {
		t.Fatal("Create returned nil error, want invalid model error")
	}
	var invalidModel *InvalidModelError
	if !errors.As(err, &invalidModel) {
		t.Fatalf("Create error = %T %[1]v, want InvalidModelError", err)
	}
	if invalidModel.Provider != "claude-code" || !slices.Equal(invalidModel.AvailableModels, []string{"default", "sonnet"}) {
		t.Fatalf("invalid model error = %#v", invalidModel)
	}
	if len(runtime.startCalls) != 0 {
		t.Fatalf("start calls = %d, want 0", len(runtime.startCalls))
	}
	if prepareInput.Provider != "" {
		t.Fatalf("runtime preparer was called: %#v", prepareInput)
	}
}

func TestServiceCreateUsesProviderDefaultModelWhenModelOmitted(t *testing.T) {
	runtime := newFakeRuntime()
	service := newTestService(runtime)
	service.ModelCatalog = fakeModelCatalog{
		result: AgentModelCatalogResult{
			Provider: "codex",
			Source:   "codex-cli",
			Models: []AgentModelOption{
				{ID: "gpt-5", DisplayName: "GPT-5", IsDefault: true},
				{ID: "gpt-5.1", DisplayName: "GPT-5.1"},
			},
		},
	}
	var prepareInput runtimeprep.PrepareInput
	service.RuntimePreparer = fakeRuntimePreparer{
		input: &prepareInput,
	}

	session, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentSessionID: "33333333-3333-4333-8333-333333333333",
		AgentTargetID:  agenttargetbiz.IDLocalCodex,
		Provider:       "codex",
		InitialContent: TextPromptContent("hello"),
	})
	if err != nil {
		t.Fatalf("Create returned error: %v", err)
	}
	if len(runtime.startCalls) != 1 {
		t.Fatalf("start calls = %d, want 1", len(runtime.startCalls))
	}
	if runtime.startCalls[0].Model != "gpt-5" {
		t.Fatalf("runtime model = %q, want default gpt-5", runtime.startCalls[0].Model)
	}
	if prepareInput.Model != "gpt-5" {
		t.Fatalf("prepare model = %q, want default gpt-5", prepareInput.Model)
	}
	if session.Settings == nil || session.Settings.Model != "gpt-5" {
		t.Fatalf("session settings = %#v, want default model", session.Settings)
	}
}

func TestServiceCreateRecoversRetiredRememberedModelToProviderDefault(t *testing.T) {
	runtime := newFakeRuntime()
	service := newTestService(runtime)
	service.AgentComposerDefaultsReader = fakeAgentComposerDefaultsReader{
		agenttargetbiz.IDLocalCodex: {Model: "gpt-5.4"},
	}
	service.ModelCatalog = fakeModelCatalog{
		result: AgentModelCatalogResult{
			Provider: "codex",
			Source:   "codex-cli",
			Models: []AgentModelOption{
				{ID: "gpt-5.6-sol", DisplayName: "GPT-5.6-Sol", IsDefault: true},
				{ID: "gpt-5.5", DisplayName: "GPT-5.5"},
			},
		},
	}

	session, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentSessionID: "34343434-3434-4434-8434-343434343434",
		AgentTargetID:  agenttargetbiz.IDLocalCodex,
		Provider:       "codex",
		InitialContent: TextPromptContent("hello"),
	})
	if err != nil {
		t.Fatalf("Create returned error: %v", err)
	}
	if len(runtime.startCalls) != 1 || runtime.startCalls[0].Model != "gpt-5.6-sol" {
		t.Fatalf("runtime start calls = %#v, want provider default model", runtime.startCalls)
	}
	if session.Settings == nil || session.Settings.Model != "gpt-5.6-sol" {
		t.Fatalf("session settings = %#v, want provider default model", session.Settings)
	}
}

func TestServiceCreateRecoversTransportMarkedInheritedModelToProviderDefault(t *testing.T) {
	runtime := newFakeRuntime()
	service := newTestService(runtime)
	service.ModelCatalog = fakeModelCatalog{result: AgentModelCatalogResult{
		Provider: "codex",
		Models:   []AgentModelOption{{ID: "gpt-current", IsDefault: true}},
	}}
	inherited := false
	session, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentSessionID: "35353535-3535-4535-8535-353535353535",
		AgentTargetID:  agenttargetbiz.IDLocalCodex,
		Provider:       "codex",
		Model:          stringRef("gpt-retired"),
		ModelExplicit:  &inherited,
	})
	if err != nil {
		t.Fatalf("Create returned error: %v", err)
	}
	if session.Settings == nil || session.Settings.Model != "gpt-current" {
		t.Fatalf("session settings = %#v, want provider default", session.Settings)
	}
}

func TestServiceCreateClampsLegacyMaxToSelectedModelCapability(t *testing.T) {
	runtime := newFakeRuntime()
	service := newTestService(runtime)
	service.ModelCatalog = fakeModelCatalog{
		result: AgentModelCatalogResult{
			Provider: "codex",
			Source:   "codex-cli",
			Models: []AgentModelOption{{
				ID:                         "gpt-5.3-codex-spark",
				DefaultReasoningEffort:     "xhigh",
				ReasoningEffortsAdvertised: true,
				SupportedReasoningEfforts: []AgentModelReasoningEffortOption{
					{Value: "low"},
					{Value: "medium"},
					{Value: "high"},
					{Value: "xhigh"},
				},
			}},
		},
	}

	session, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentSessionID:  "44444444-4444-4444-8444-444444444444",
		AgentTargetID:   agenttargetbiz.IDLocalCodex,
		Provider:        "codex",
		Model:           stringRef("gpt-5.3-codex-spark"),
		ReasoningEffort: stringRef("max"),
	})
	if err != nil {
		t.Fatalf("Create returned error: %v", err)
	}
	if len(runtime.startCalls) != 1 || runtime.startCalls[0].ReasoningEffort != "xhigh" {
		t.Fatalf("runtime start calls = %#v, want Spark reasoning xhigh", runtime.startCalls)
	}
	if session.Settings == nil || session.Settings.ReasoningEffort != "xhigh" {
		t.Fatalf("session settings = %#v, want Spark reasoning xhigh", session.Settings)
	}
}

func TestClampReasoningEffortForKnownProviderBehindAgentExtension(t *testing.T) {
	service := newTestService(newFakeRuntime())
	service.ModelCatalog = fakeModelCatalog{result: AgentModelCatalogResult{
		Provider: "opencode",
		Models: []AgentModelOption{{
			ID:                         "openai/gpt-5.3-codex-spark",
			DefaultReasoningEffort:     "xhigh",
			ReasoningEffortsAdvertised: true,
			SupportedReasoningEfforts: []AgentModelReasoningEffortOption{
				{Value: "low"}, {Value: "medium"}, {Value: "high"}, {Value: "xhigh"},
			},
		}},
	}}
	selected := "none"
	got := service.clampReasoningEffortPointerForLaunch(
		context.Background(),
		"opencode",
		map[string]any{"kind": "agent_extension"},
		"/workspace/project",
		"openai/gpt-5.3-codex-spark",
		&selected,
	)
	if got == nil || *got != "xhigh" {
		t.Fatalf("reasoning effort = %#v, want xhigh", got)
	}
}

func TestServiceCreateRejectsExplicitOpenCodeReasoningUnsupportedByTargetModel(t *testing.T) {
	runtime := newFakeRuntime()
	service := newTestService(runtime)
	catalogInputs := []AgentModelCatalogInput{}
	service.ModelCatalog = fakeModelCatalog{
		inputs: &catalogInputs,
		result: AgentModelCatalogResult{
			Provider: "opencode",
			Source:   "opencode-cli",
			Models: []AgentModelOption{{
				ID:                         "openai/gpt-5.3-codex-spark",
				IsDefault:                  true,
				DefaultReasoningEffort:     "medium",
				ReasoningEffortsAdvertised: true,
				SupportedReasoningEfforts: []AgentModelReasoningEffortOption{
					{Value: "low"},
					{Value: "medium"},
					{Value: "high"},
					{Value: "xhigh"},
				},
			}},
		},
	}

	_, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentSessionID:  "45454545-4545-4545-8545-454545454545",
		AgentTargetID:   agenttargetbiz.IDLocalOpenCode,
		Provider:        "opencode",
		Model:           stringRef("openai/gpt-5.3-codex-spark"),
		ReasoningEffort: stringRef("none"),
		Cwd:             stringRef("/workspace/project"),
	})
	if !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("Create error = %v, want ErrInvalidArgument", err)
	}
	if len(runtime.startCalls) != 0 {
		t.Fatalf("runtime start calls = %#v, want none", runtime.startCalls)
	}
	if len(catalogInputs) != 1 {
		t.Fatalf("model catalog queries = %d, want one request-scoped lookup", len(catalogInputs))
	}
	for _, input := range catalogInputs {
		if input.Cwd != "/workspace/project" {
			t.Fatalf("catalog input = %#v, want workspace cwd", input)
		}
	}
}

func TestServiceCreateUsesAllocatedCwdForOpenCodeCatalogAndRuntime(t *testing.T) {
	runtime := newFakeRuntime()
	service := newTestService(runtime)
	allocated := t.TempDir()
	service.SessionDirectoryAllocator = &recordingSessionDirectoryAllocator{path: allocated}
	catalogInputs := []AgentModelCatalogInput{}
	service.ModelCatalog = fakeModelCatalog{
		inputs: &catalogInputs,
		result: AgentModelCatalogResult{
			Provider: "opencode",
			Models: []AgentModelOption{{
				ID:                         "openai/gpt-current",
				IsDefault:                  true,
				DefaultReasoningEffort:     "medium",
				ReasoningEffortsAdvertised: true,
				SupportedReasoningEfforts:  []AgentModelReasoningEffortOption{{Value: "medium"}},
			}},
		},
	}

	if _, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentSessionID:  "47474747-4747-4747-8747-474747474747",
		AgentTargetID:   agenttargetbiz.IDLocalOpenCode,
		Provider:        "opencode",
		ReasoningEffort: stringRef("medium"),
	}); err != nil {
		t.Fatalf("Create returned error: %v", err)
	}
	if len(catalogInputs) != 1 || catalogInputs[0].Cwd != allocated {
		t.Fatalf("catalog inputs = %#v, want allocated cwd %q", catalogInputs, allocated)
	}
	if len(runtime.startCalls) != 1 || runtime.startCalls[0].Cwd != allocated {
		t.Fatalf("runtime starts = %#v, want allocated cwd %q", runtime.startCalls, allocated)
	}
}

func TestServiceCreateReleasesAllocatedCwdWhenOpenCodeValidationFails(t *testing.T) {
	runtime := newFakeRuntime()
	service := newTestService(runtime)
	stateDir := t.TempDir()
	now := func() time.Time { return time.Date(2026, 8, 14, 0, 0, 0, 0, time.UTC) }
	allocator := LocalSessionDirectoryAllocator{StateDir: stateDir, Now: now}
	service.SessionDirectoryAllocator = allocator
	service.ModelCatalog = fakeModelCatalog{result: AgentModelCatalogResult{
		Provider: "opencode",
		Models: []AgentModelOption{{
			ID:                         "openai/gpt-current",
			IsDefault:                  true,
			ReasoningEffortsAdvertised: true,
			SupportedReasoningEfforts:  []AgentModelReasoningEffortOption{{Value: "medium"}},
		}},
	}}

	_, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentSessionID:  "48484848-4848-4848-8848-484848484848",
		AgentTargetID:   agenttargetbiz.IDLocalOpenCode,
		Provider:        "opencode",
		ReasoningEffort: stringRef("unsupported"),
	})
	if !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("Create error = %v, want ErrInvalidArgument", err)
	}
	want := filepath.Join(stateDir, "agent", "sessions", "2026-08-14-001")
	if _, statErr := os.Stat(want); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("rolled back directory stat error = %v, want not exist", statErr)
	}
	reused, allocErr := allocator.CreateSessionDirectory(context.Background())
	if allocErr != nil {
		t.Fatalf("CreateSessionDirectory after rollback error = %v", allocErr)
	}
	if reused != want {
		t.Fatalf("reused path = %q, want %q", reused, want)
	}
}

func TestServiceCreateRejectsExplicitOpenCodeReasoningWithoutAdvertisedMetadata(t *testing.T) {
	runtime := newFakeRuntime()
	service := newTestService(runtime)
	service.ModelCatalog = fakeModelCatalog{
		result: AgentModelCatalogResult{
			Provider: "opencode",
			Source:   "opencode-cli",
			Models: []AgentModelOption{{
				ID:        "openai/gpt-5.3-codex-spark",
				IsDefault: true,
			}},
		},
	}

	_, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentSessionID:  "46464646-4646-4646-8646-464646464646",
		AgentTargetID:   agenttargetbiz.IDLocalOpenCode,
		Provider:        "opencode",
		Model:           stringRef("openai/gpt-5.3-codex-spark"),
		ReasoningEffort: stringRef("none"),
	})
	if !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("Create error = %v, want ErrInvalidArgument", err)
	}
	if len(runtime.startCalls) != 0 {
		t.Fatalf("runtime start calls = %#v, want none", runtime.startCalls)
	}
}

func TestServiceCreatePreservesAdvertisedReasoningEffort(t *testing.T) {
	for _, effort := range []string{"minimal", "none"} {
		t.Run(effort, func(t *testing.T) {
			runtime := newFakeRuntime()
			service := newTestService(runtime)
			service.ModelCatalog = fakeModelCatalog{
				result: AgentModelCatalogResult{
					Provider: "codex",
					Source:   "codex-cli",
					Models: []AgentModelOption{{
						ID:                         "gpt-catalog",
						DefaultReasoningEffort:     "high",
						ReasoningEffortsAdvertised: true,
						SupportedReasoningEfforts: []AgentModelReasoningEffortOption{
							{Value: "minimal"}, {Value: "none"}, {Value: "high"},
						},
					}},
				},
			}

			session, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
				AgentSessionID:  "55555555-5555-4555-8555-555555555555",
				AgentTargetID:   agenttargetbiz.IDLocalCodex,
				Provider:        "codex",
				Model:           stringRef("gpt-catalog"),
				ReasoningEffort: stringRef(effort),
			})
			if err != nil {
				t.Fatalf("Create returned error: %v", err)
			}
			if len(runtime.startCalls) != 1 || runtime.startCalls[0].ReasoningEffort != effort {
				t.Fatalf("runtime start calls = %#v, want reasoning %q", runtime.startCalls, effort)
			}
			if session.Settings == nil || session.Settings.ReasoningEffort != effort {
				t.Fatalf("session settings = %#v, want reasoning %q", session.Settings, effort)
			}
		})
	}
}

func TestServiceCreatePassesPlanModeToRuntime(t *testing.T) {
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
	runtime := newFakeRuntime()
	service := newTestService(runtime)
	planMode := true

	session, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentSessionID: "11111111-1111-4111-8111-111111111111",
		AgentTargetID:  agenttargetbiz.IDLocalClaudeCode,
		InitialContent: TextPromptContent("hello"),
		PlanMode:       &planMode,
		Provider:       "claude-code",
	})
	if err != nil {
		t.Fatalf("Create returned error: %v", err)
	}
	if len(runtime.startCalls) != 1 {
		t.Fatalf("start calls = %d, want 1", len(runtime.startCalls))
	}
	if !runtime.startCalls[0].PlanMode {
		t.Fatal("runtime start plan mode = false, want true")
	}
	if session.Settings == nil || !session.Settings.PlanMode {
		t.Fatalf("session settings = %#v, want plan mode true", session.Settings)
	}
}

func TestServiceCreateClampsPlanModeForProvidersWithoutCapability(t *testing.T) {
	runtime := newFakeRuntime()
	service := newTestService(runtime)
	planMode := true

	_, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentSessionID: "22222222-2222-4222-8222-222222222222",
		InitialContent: TextPromptContent("hello"),
		PlanMode:       &planMode,
		Provider:       "hermes",
	})
	if !errors.Is(err, ErrInvalidArgument) || !strings.Contains(err.Error(), "agent target id is required") {
		t.Fatalf("Create error = %v, want missing agent target ErrInvalidArgument", err)
	}
	if len(runtime.startCalls) != 0 {
		t.Fatalf("start calls = %d, want 0", len(runtime.startCalls))
	}
}

func TestServiceCreateCleansPreparedRuntimeWhenStartFails(t *testing.T) {
	startErr := errors.New("start failed")
	runtime := newFakeRuntime()
	runtime.startErr = startErr
	service := newTestService(runtime)
	checker := &fakeProviderAvailabilityChecker{}
	service.AvailabilityChecker = checker
	cleanupCalls := make([]runtimeprep.CleanupInput, 0)
	service.RuntimePreparer = fakeRuntimePreparer{
		result:       runtimeprep.PreparedRuntime{Cwd: "/prepared/workdir"},
		cleanupCalls: &cleanupCalls,
	}

	_, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentSessionID: "session-1",
		AgentTargetID:  agenttargetbiz.IDLocalCodex,
		InitialContent: TextPromptContent("hello"),
		Provider:       "codex",
	})
	if !errors.Is(err, startErr) {
		t.Fatalf("Create error = %v, want %v", err, startErr)
	}
	if len(cleanupCalls) != 1 ||
		cleanupCalls[0].WorkspaceID != "ws-1" ||
		cleanupCalls[0].AgentSessionID != "session-1" {
		t.Fatalf("cleanup calls = %#v", cleanupCalls)
	}
	if checker.callCount != 0 {
		t.Fatalf("availability checker calls = %d, want 0", checker.callCount)
	}
	if len(checker.invalidations) != 1 || checker.invalidations[0] != "codex" {
		t.Fatalf("availability invalidations = %#v, want [codex]", checker.invalidations)
	}
}

func TestServiceCreateRejectsInvalidContentBeforePreparingRuntime(t *testing.T) {
	runtime := newFakeRuntime()
	service := newTestService(runtime)
	prepareInput := (*runtimeprep.PrepareInput)(nil)
	service.RuntimePreparer = fakeRuntimePreparer{
		input: prepareInput,
	}

	_, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentSessionID: "session-1",
		AgentTargetID:  agenttargetbiz.IDLocalCodex,
		InitialContent: []PromptContentBlock{{
			Type:     "image",
			MimeType: "image/png",
			Data:     "not-base64",
		}},
		Provider: "codex",
	})
	if !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("Create error = %v, want ErrInvalidArgument", err)
	}
	if len(runtime.startCalls) != 0 {
		t.Fatalf("start calls = %d, want 0", len(runtime.startCalls))
	}
}

func TestServiceCreateDoesNotRunProviderStatusBeforePreparingRuntime(t *testing.T) {
	runtime := newFakeRuntime()
	service := newTestService(runtime)
	var prepareInput runtimeprep.PrepareInput
	service.RuntimePreparer = fakeRuntimePreparer{
		input: &prepareInput,
		result: runtimeprep.PreparedRuntime{
			Cwd: "/prepared/workdir",
		},
	}
	checker := &fakeProviderAvailabilityChecker{
		result: []ProviderAvailability{{
			Provider: "claude-code",
			Status:   ProviderAvailabilityUnavailable,
			Checks: []ProviderAvailabilityCheck{
				{Name: "cli", Passed: true, Detail: "/usr/local/bin/claude"},
				{Name: "adapter", Passed: false, Detail: "ACP adapter not found"},
				{Name: "auth", Passed: true, Detail: "authenticated"},
			},
			LastError: &ProviderAvailabilityError{
				Code:    "acp_adapter_not_found",
				Message: "ACP adapter not found",
			},
		}},
	}
	service.AvailabilityChecker = checker

	_, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentSessionID: "session-1",
		AgentTargetID:  agenttargetbiz.IDLocalClaudeCode,
		InitialContent: TextPromptContent("hello"),
		Provider:       "claude-code",
	})
	if err != nil {
		t.Fatalf("Create error = %v, want nil", err)
	}
	if checker.callCount != 0 {
		t.Fatalf("availability checker callCount = %d, want 0", checker.callCount)
	}
	if prepareInput.WorkspaceID != "ws-1" {
		t.Fatalf("runtime preparer input = %#v, want workspace ws-1", prepareInput)
	}
	if len(runtime.startCalls) != 1 {
		t.Fatalf("start calls = %d, want 1", len(runtime.startCalls))
	}
	if len(runtime.execCalls) != 1 {
		t.Fatalf("exec calls = %d, want 1", len(runtime.execCalls))
	}
}

func TestServiceCreateDoesNotTreatAuthRequiredAsInstallNeeded(t *testing.T) {
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
	runtime := newFakeRuntime()
	service := newTestService(runtime)
	checker := &fakeProviderAvailabilityChecker{
		result: []ProviderAvailability{{
			Provider: "claude-code",
			Status:   ProviderAvailabilityUnavailable,
			Checks: []ProviderAvailabilityCheck{
				{Name: "cli", Passed: true, Detail: "/usr/local/bin/claude"},
				{Name: "adapter", Passed: true, Detail: "/opt/tutti/claude-sdk-sidecar"},
				{Name: "auth", Passed: false, Detail: "authentication required"},
			},
			LastError: &ProviderAvailabilityError{
				Code:    "auth_required",
				Message: "authentication required",
			},
		}},
	}
	service.AvailabilityChecker = checker

	_, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentSessionID: "session-1",
		AgentTargetID:  agenttargetbiz.IDLocalClaudeCode,
		InitialContent: TextPromptContent("hello"),
		Provider:       "claude-code",
	})
	if err != nil {
		t.Fatalf("Create error = %v, want nil", err)
	}
	if len(runtime.startCalls) != 1 {
		t.Fatalf("start calls = %d, want 1", len(runtime.startCalls))
	}
}

func TestServiceCreateNeverRepeatsApplicationProviderProbe(t *testing.T) {
	runtime := newFakeRuntime()
	service := newTestService(runtime)
	checker := &fakeProviderAvailabilityChecker{
		result: []ProviderAvailability{{
			Provider: "codex",
			Status:   ProviderAvailabilityAvailable,
		}},
	}
	service.AvailabilityChecker = checker

	for _, sessionID := range []string{"session-1", "session-2"} {
		_, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
			AgentSessionID: sessionID,
			AgentTargetID:  agenttargetbiz.IDLocalCodex,
			InitialContent: TextPromptContent("hello"),
			Provider:       "codex",
		})
		if err != nil {
			t.Fatalf("Create(%s) error = %v, want nil", sessionID, err)
		}
	}
	if checker.callCount != 0 {
		t.Fatalf("availability checker calls = %d, want 0", checker.callCount)
	}
	if len(runtime.startCalls) != 2 {
		t.Fatalf("start calls = %d, want 2", len(runtime.startCalls))
	}
}

func TestServiceSendInputRejectsUnsupportedImageBeforePersistingAttachment(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.validateErr = ErrPromptImageUnsupported
	service := newIsolatedAgentService(runtime)
	tempDir := t.TempDir()
	service.PromptAttachmentStore = PromptAttachmentStore{RootDir: tempDir}
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{
		ID:          "session-1",
		WorkspaceID: "ws-1",
		Provider:    "codex",
		Status:      "ready",
		Visible:     true,
	}

	_, err := service.SendInput(context.Background(), "ws-1", "session-1", SendInput{
		Content: []PromptContentBlock{{
			Type:     "image",
			MimeType: "image/png",
			Data:     "aGVsbG8=",
		}},
	})
	if !errors.Is(err, ErrPromptImageUnsupported) {
		t.Fatalf("SendInput error = %v, want ErrPromptImageUnsupported", err)
	}
	if len(runtime.execCalls) != 0 {
		t.Fatalf("exec calls = %d, want 0", len(runtime.execCalls))
	}
	if entries, err := os.ReadDir(filepath.Join(tempDir, "agent", "attachments")); err == nil && len(entries) > 0 {
		t.Fatalf("attachment entries = %#v, want none", entries)
	}
}

func TestServiceLocalAttachmentPathRequiresWorkspaceSession(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{
		ID:          "session-1",
		WorkspaceID: "ws-1",
		Provider:    "codex",
		Status:      "ready",
		Visible:     true,
	}
	service := newIsolatedAgentService(runtime)
	tempDir := t.TempDir()
	service.PromptAttachmentStore = PromptAttachmentStore{RootDir: tempDir}
	path, err := service.PromptAttachmentStore.attachmentPath("ws-1", "session-1", "attachment-1", "image/png")
	if err != nil {
		t.Fatalf("attachmentPath() error = %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(path, []byte("png"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	got, err := service.LocalAttachmentPath(context.Background(), "ws-1", "session-1", "attachment-1", "image/png")
	if err != nil {
		t.Fatalf("LocalAttachmentPath() error = %v", err)
	}
	if got != path {
		t.Fatalf("LocalAttachmentPath() = %q, want %q", got, path)
	}
	if _, err := service.LocalAttachmentPath(context.Background(), "ws-2", "session-1", "attachment-1", "image/png"); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("LocalAttachmentPath() cross-workspace error = %v, want ErrSessionNotFound", err)
	}
}

func TestServiceCreateCleansPreparedRuntimeWhenInitialPromptFails(t *testing.T) {
	execErr := errors.New("exec failed")
	runtime := newFakeRuntime()
	runtime.execErr = execErr
	service := newTestService(runtime)
	cleanupCalls := make([]runtimeprep.CleanupInput, 0)
	service.RuntimePreparer = fakeRuntimePreparer{
		result:       runtimeprep.PreparedRuntime{Cwd: "/prepared/workdir"},
		cleanupCalls: &cleanupCalls,
	}

	_, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentSessionID: "session-1",
		AgentTargetID:  agenttargetbiz.IDLocalCodex,
		Provider:       "codex",
		InitialContent: TextPromptContent("hello"),
	})
	if !errors.Is(err, execErr) {
		t.Fatalf("Create error = %v, want %v", err, execErr)
	}
	if len(runtime.closeCalls) != 1 || runtime.closeCalls[0].AgentSessionID != "session-1" {
		t.Fatalf("close calls = %#v", runtime.closeCalls)
	}
	if len(cleanupCalls) != 1 ||
		cleanupCalls[0].WorkspaceID != "ws-1" ||
		cleanupCalls[0].AgentSessionID != "session-1" {
		t.Fatalf("cleanup calls = %#v", cleanupCalls)
	}
	if _, ok := runtime.Session("ws-1", "session-1"); ok {
		t.Fatal("runtime session still exists after failed initial prompt")
	}
}

func TestServiceCreatePassesInitialDisplayPromptToRuntime(t *testing.T) {
	runtime := newFakeRuntime()
	service := newTestService(runtime)
	service.SubmitClaimStore = openAgentServiceSQLiteStore(t)

	_, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentSessionID:       "session-1",
		AgentTargetID:        agenttargetbiz.IDLocalCodex,
		Provider:             "codex",
		InitialContent:       TextPromptContent("real automation prompt"),
		InitialDisplayPrompt: "Run Automation",
		Metadata: map[string]any{
			"":                        "drop",
			"clientSubmitId":          "submit-create-1",
			"clientSubmittedAtUnixMs": int64(12345),
			" spacedDiagnosticKey ":   "trimmed",
		},
	})
	if err != nil {
		t.Fatalf("Create error = %v", err)
	}
	if len(runtime.execCalls) != 1 {
		t.Fatalf("exec calls = %d, want 1", len(runtime.execCalls))
	}
	call := runtime.execCalls[0]
	if len(call.Content) != 1 || call.Content[0].Text != "real automation prompt" {
		t.Fatalf("runtime content = %#v", call.Content)
	}
	if call.DisplayPrompt != "Run Automation" {
		t.Fatalf("runtime display prompt = %q", call.DisplayPrompt)
	}
	if call.InitialTitle != "Run Automation" {
		t.Fatalf("runtime initial title = %q", call.InitialTitle)
	}
	if call.Metadata["clientSubmitId"] != "submit-create-1" || call.Metadata["spacedDiagnosticKey"] != "trimmed" {
		t.Fatalf("runtime metadata = %#v", call.Metadata)
	}
	if call.CanonicalSubmitOccurredAtUnixMS <= 0 || len(runtime.provenanceCalls) != 1 ||
		runtime.provenanceCalls[0].CanonicalSubmitOccurredAtUnixMS != call.CanonicalSubmitOccurredAtUnixMS {
		t.Fatalf("canonical submit occurrence exec=%d provenance=%#v", call.CanonicalSubmitOccurredAtUnixMS, runtime.provenanceCalls)
	}
	if _, ok := call.Metadata[""]; ok {
		t.Fatalf("runtime metadata includes blank key: %#v", call.Metadata)
	}
}

func TestServiceCreateEmptySessionDoesNotExec(t *testing.T) {
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
	runtime := newFakeRuntime()
	service := newTestService(runtime)
	visible := false

	session, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentSessionID: "session-1",
		AgentTargetID:  agenttargetbiz.IDLocalClaudeCode,
		Provider:       "claude-code",
		Visible:        &visible,
	})
	if err != nil {
		t.Fatalf("Create error = %v", err)
	}
	if session.ID != "session-1" {
		t.Fatalf("session id = %q, want session-1", session.ID)
	}
	if session.Visible {
		t.Fatal("session visible = true, want false")
	}
	if len(runtime.startCalls) != 1 {
		t.Fatalf("start calls = %d, want 1", len(runtime.startCalls))
	}
	if len(runtime.validateCalls) != 0 {
		t.Fatalf("validate calls = %d, want 0", len(runtime.validateCalls))
	}
	if len(runtime.execCalls) != 0 {
		t.Fatalf("exec calls = %d, want 0", len(runtime.execCalls))
	}
}

func TestServiceCreateClaudeModelValidationUsesOnlyCachedLiveModels(t *testing.T) {
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
	runtime := newFakeRuntime()
	service := newTestService(runtime)

	_, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentSessionID: "session-1",
		AgentTargetID:  agenttargetbiz.IDLocalClaudeCode,
		Provider:       "claude-code",
		Model:          stringRef("custom-claude-model"),
		InitialContent: TextPromptContent("hello"),
	})
	if err != nil {
		t.Fatalf("Create error = %v", err)
	}
	if len(runtime.startCalls) != 1 {
		t.Fatalf("start calls = %d, want only real session start", len(runtime.startCalls))
	}
	if got := runtime.startCalls[0].AgentSessionID; got != "session-1" {
		t.Fatalf("started session id = %q, want real session id", got)
	}
}

func TestServiceCreateDoesNotPassDerivedPromptToRuntime(t *testing.T) {
	runtime := newFakeRuntime()
	service := newTestService(runtime)

	_, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentSessionID: "session-1",
		AgentTargetID:  agenttargetbiz.IDLocalCodex,
		Provider:       "codex",
		InitialContent: TextPromptContent("ordinary prompt"),
	})
	if err != nil {
		t.Fatalf("Create error = %v", err)
	}
	if len(runtime.execCalls) != 1 {
		t.Fatalf("exec calls = %d, want 1", len(runtime.execCalls))
	}
	if runtime.execCalls[0].DisplayPrompt != "" {
		t.Fatalf("runtime display prompt = %q, want empty explicit display prompt", runtime.execCalls[0].DisplayPrompt)
	}
}

func TestServiceUpdateVisibleUpdatesRuntimeSession(t *testing.T) {
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
	runtime := newFakeRuntime()
	service := newTestService(runtime)
	visible := false
	created, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentSessionID: "session-1",
		AgentTargetID:  agenttargetbiz.IDLocalClaudeCode,
		Provider:       "claude-code",
		Visible:        &visible,
	})
	if err != nil {
		t.Fatalf("Create error = %v", err)
	}
	if created.Visible {
		t.Fatal("created visible = true, want false")
	}

	session, err := service.UpdateVisible(context.Background(), "ws-1", "session-1", true)
	if err != nil {
		t.Fatalf("UpdateVisible error = %v", err)
	}
	if !session.Visible {
		t.Fatal("updated visible = false, want true")
	}
	runtimeSession, ok := runtime.Session("ws-1", "session-1")
	if !ok || !runtimeSession.Visible {
		t.Fatalf("runtime session = %#v, ok=%v; want visible true", runtimeSession, ok)
	}
}

func TestServiceSendInputPassesDisplayPromptToRuntime(t *testing.T) {
	runtime := newFakeRuntime()
	service := newIsolatedAgentService(runtime)
	service.SubmitClaimStore = openAgentServiceSQLiteStore(t)
	activeTurnID := "turn-1"
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{
		ID:          "session-1",
		WorkspaceID: "ws-1",
		Provider:    "codex",
		Status:      "ready",
		Visible:     true,
		TurnLifecycle: &TurnLifecycle{
			ActiveTurnID: &activeTurnID,
			Phase:        "running",
		},
	}

	_, err := service.SendInput(context.Background(), "ws-1", "session-1", SendInput{
		Content:        TextPromptContent("real repair prompt"),
		DisplayPrompt:  "Fix the app",
		Guidance:       true,
		TurnID:         activeTurnID,
		ClientSubmitID: "submit-1",
		Metadata: map[string]any{
			"clientSubmittedAtUnixMs":    int64(1234),
			" ignoredBlankKeyIsRemoved ": true,
			"":                           "drop",
		},
	})
	if err != nil {
		t.Fatalf("SendInput error = %v", err)
	}
	if len(runtime.execCalls) != 1 {
		t.Fatalf("exec calls = %d, want 1", len(runtime.execCalls))
	}
	call := runtime.execCalls[0]
	if len(call.Content) != 1 || call.Content[0].Text != "real repair prompt" {
		t.Fatalf("runtime content = %#v", call.Content)
	}
	if call.DisplayPrompt != "Fix the app" {
		t.Fatalf("runtime display prompt = %q", call.DisplayPrompt)
	}
	if !call.Guidance {
		t.Fatal("runtime guidance = false, want true")
	}
	if call.Metadata["clientSubmitId"] != "submit-1" ||
		call.Metadata["clientSubmittedAtUnixMs"] != int64(1234) ||
		call.Metadata["ignoredBlankKeyIsRemoved"] != true {
		t.Fatalf("runtime metadata = %#v", call.Metadata)
	}
	if call.CanonicalSubmitOccurredAtUnixMS <= 0 || len(runtime.provenanceCalls) != 1 ||
		runtime.provenanceCalls[0].CanonicalSubmitOccurredAtUnixMS != call.CanonicalSubmitOccurredAtUnixMS {
		t.Fatalf("canonical submit occurrence exec=%d provenance=%#v", call.CanonicalSubmitOccurredAtUnixMS, runtime.provenanceCalls)
	}
	if _, ok := call.Metadata[""]; ok {
		t.Fatalf("runtime metadata includes blank key: %#v", call.Metadata)
	}
}

func TestServiceSendInputDoesNotExecuteDuplicateClientSubmitID(t *testing.T) {
	runtime := newFakeRuntime()
	service := newTestService(runtime)
	store := openAgentServiceSQLiteStore(t)
	service.SubmitClaimStore = store
	if _, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentSessionID: "session-idempotent", AgentTargetID: agenttargetbiz.IDLocalCodex,
	}); err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	input := SendInput{Content: TextPromptContent("hello"), Metadata: map[string]any{"clientSubmitId": "submit-1"}}
	if _, err := service.SendInput(context.Background(), "ws-1", "session-idempotent", input); err != nil {
		t.Fatalf("first SendInput() error = %v", err)
	}
	if _, err := service.SendInput(context.Background(), "ws-1", "session-idempotent", input); !errors.Is(err, ErrSubmitDeliveryUnknown) {
		t.Fatalf("duplicate SendInput() error = %v, want delivery unknown without replay", err)
	}
	if len(runtime.execCalls) != 1 {
		t.Fatalf("exec calls = %d, want 1", len(runtime.execCalls))
	}
}

// TestServiceSendInputGeneratesClientSubmitIDForSubmitProvenance 守住 agent send
// 的回归（与 Create 对称）：调用方未提供 ClientSubmitID 时 service 层兜底生成，
// 否则 SendInput 路径的 submit provenance（lifecycle.go SendInput）会让已派发的
// turn 误报 ErrSubmitDeliveryUnknown。
func TestServiceSendInputGeneratesClientSubmitIDForSubmitProvenance(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.provenanceHook = func(input RuntimeSubmitProvenanceInput) error {
		if input.WorkspaceID == "" || input.AgentSessionID == "" || input.TurnID == "" || input.ClientSubmitID == "" {
			return errors.New("workspace id, agent session id, turn id, and client submit id are required")
		}
		return nil
	}
	service := newTestService(runtime)
	store := openAgentServiceSQLiteStore(t)
	service.SubmitClaimStore = store
	if _, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentSessionID: "session-provenance", AgentTargetID: agenttargetbiz.IDLocalCodex,
	}); err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	// 故意不传 ClientSubmitID，也不传 legacy metadata
	if _, err := service.SendInput(context.Background(), "ws-1", "session-provenance", SendInput{
		Content: TextPromptContent("hello"),
	}); err != nil {
		t.Fatalf("SendInput error = %v (兜底生成的 ClientSubmitID 应让 submit provenance 通过)", err)
	}
	if len(runtime.provenanceCalls) != 1 {
		t.Fatalf("provenance calls = %d, want 1", len(runtime.provenanceCalls))
	}
	if runtime.provenanceCalls[0].ClientSubmitID == "" {
		t.Fatal("provenance 收到空 ClientSubmitID，service 层兜底未生效")
	}
}

func TestServiceSendInputWaitsForClaudeStartupSlotBeforeExec(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{
		ID:          "session-1",
		WorkspaceID: "ws-1",
		Provider:    "claude-code",
		Status:      "ready",
		Visible:     true,
	}
	service := newIsolatedAgentService(runtime)
	if err := service.claudeStartup().Acquire(context.Background()); err != nil {
		t.Fatalf("acquire startup lock: %v", err)
	}

	done := make(chan error, 1)
	go func() {
		_, err := service.SendInput(context.Background(), "ws-1", "session-1", SendInput{
			Content: TextPromptContent("hello"),
		})
		done <- err
	}()

	select {
	case err := <-done:
		t.Fatalf("SendInput completed while startup slot held: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	if len(runtime.execCalls) != 0 {
		t.Fatalf("exec calls = %d, want blocked while startup slot held", len(runtime.execCalls))
	}
	service.claudeStartup().Release()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("SendInput error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("SendInput did not continue after startup slot release")
	}
	if len(runtime.execCalls) != 1 {
		t.Fatalf("exec calls = %d, want 1 after startup slot release", len(runtime.execCalls))
	}
}

func TestServiceCreateGeneratesSessionIDBeforePreparingRuntime(t *testing.T) {
	runtime := newFakeRuntime()
	var prepareInput runtimeprep.PrepareInput
	service := newTestService(runtime)
	service.RuntimePreparer = fakeRuntimePreparer{
		input: &prepareInput,
		result: runtimeprep.PreparedRuntime{
			Cwd: "/prepared/workdir",
		},
	}
	cwd := "/user/workdir"

	session, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentTargetID:  agenttargetbiz.IDLocalCodex,
		Cwd:            &cwd,
		Provider:       "codex",
		InitialContent: TextPromptContent("hello"),
	})
	if err != nil {
		t.Fatalf("Create returned error: %v", err)
	}
	if session.ID == "" {
		t.Fatal("session ID is empty, want generated ID")
	}
	if prepareInput.AgentSessionID != session.ID {
		t.Fatalf("prepare agentSessionID = %q, want %q", prepareInput.AgentSessionID, session.ID)
	}
	if len(runtime.startCalls) != 1 {
		t.Fatalf("start calls = %d, want 1", len(runtime.startCalls))
	}
	if runtime.startCalls[0].AgentSessionID != session.ID {
		t.Fatalf("runtime agentSessionID = %q, want %q", runtime.startCalls[0].AgentSessionID, session.ID)
	}
}

func TestServiceCreatePassesExtraSkillsToRuntimePreparer(t *testing.T) {
	runtime := newFakeRuntime()
	var prepareInput runtimeprep.PrepareInput
	service := newTestService(runtime)
	service.RuntimePreparer = fakeRuntimePreparer{
		input: &prepareInput,
		result: runtimeprep.PreparedRuntime{
			Cwd: "/prepared/workdir",
		},
	}
	cwd := "/user/workdir"

	if _, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentTargetID:  agenttargetbiz.IDLocalCodex,
		Cwd:            &cwd,
		Provider:       "codex",
		InitialContent: TextPromptContent("hello"),
		ExtraSkills: []SessionSkillBundle{
			{
				Name: "app-factory",
				Files: map[string]string{
					"SKILL.md":                  "skill body",
					"references/contract.md":    "contract",
					"references/demos/demo.txt": "demo",
				},
			},
		},
	}); err != nil {
		t.Fatalf("Create returned error: %v", err)
	}
	if len(prepareInput.ExtraSkills) != 1 {
		t.Fatalf("prepare extra skills = %#v", prepareInput.ExtraSkills)
	}
	if prepareInput.ExtraSkills[0].Name != "app-factory" {
		t.Fatalf("prepare extra skill name = %q", prepareInput.ExtraSkills[0].Name)
	}
	if prepareInput.ExtraSkills[0].Files["references/contract.md"] != "contract" {
		t.Fatalf("prepare extra skill files = %#v", prepareInput.ExtraSkills[0].Files)
	}
}

func TestServiceCreatePassesExtensionRuntimePrepToRuntimePreparer(t *testing.T) {
	runtime := newFakeRuntime()
	var prepareInput runtimeprep.PrepareInput
	service := newTestService(runtime)
	service.RuntimePreparer = fakeRuntimePreparer{
		input: &prepareInput,
		result: runtimeprep.PreparedRuntime{
			Cwd: "/prepared/workdir",
		},
	}
	service.AgentTargetStore = fakeAgentTargetStore{targets: map[string]agenttargetbiz.Target{
		"extension:hermes": {
			ID:            "extension:hermes",
			Provider:      "acp:hermes",
			LaunchRefJSON: `{"type":"agent_extension","extensionInstallationId":"hermes@0.18.2"}`,
			Name:          "Hermes Agent",
			Enabled:       true,
			Source:        agenttargetbiz.SourceSystem,
		},
	}}
	runtimePrep := &runtimeprep.ExtensionRuntimePrep{
		InstructionsFile: "AGENTS.md",
		Home: &runtimeprep.ExtensionRuntimeHome{
			EnvVar:             "HERMES_HOME",
			DirName:            "hermes",
			SourceEnvVar:       "HERMES_HOME",
			SourceDefaultRel:   ".hermes",
			CopyFiles:          []string{"config.yaml", "auth.json", ".env"},
			ConfigFile:         "config.yaml",
			ConfigFormat:       "yaml",
			ExternalDirsKey:    []string{"skills", "external_dirs"},
			UserHomeSkillDir:   "skills",
			IncludeSkillRoots:  true,
			IncludeUserHomeDir: true,
		},
	}
	service.ExtensionComposerProfiles = extensionComposerProfileResolverStub{
		profile: ExtensionComposerProfile{
			RuntimePrep: runtimePrep,
			Skills: &ExtensionComposerSkillProfile{Roots: []ExtensionComposerSkillRoot{
				{Scope: "workspace", Path: ".agent_context/skills"},
			}},
		},
	}
	cwd := "/user/workdir"

	if _, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentTargetID:  "extension:hermes",
		Cwd:            &cwd,
		Provider:       "acp:hermes",
		InitialContent: TextPromptContent("hello"),
	}); err != nil {
		t.Fatalf("Create returned error: %v", err)
	}

	if prepareInput.ExtensionRuntimePrep == nil || prepareInput.ExtensionRuntimePrep.Home == nil {
		t.Fatalf("prepare extension runtime prep = %#v", prepareInput.ExtensionRuntimePrep)
	}
	if prepareInput.ExtensionRuntimePrep.Home.EnvVar != "HERMES_HOME" {
		t.Fatalf("prepare extension runtime prep = %#v", prepareInput.ExtensionRuntimePrep)
	}
	if !slices.Equal(prepareInput.ExtensionSkillRoots, []string{".agent_context/skills"}) {
		t.Fatalf("prepare extension skill roots = %#v", prepareInput.ExtensionSkillRoots)
	}
}

func TestServiceGetSkillBundleUsesRuntimeRenderer(t *testing.T) {
	runtime := newFakeRuntime()
	var renderInput runtimeprep.PrepareInput
	service := newIsolatedAgentService(runtime)
	service.AgentTargetStore = fakeAgentTargetStore{targets: defaultTestAgentTargets()}
	service.RuntimePreparer = fakeSkillBundleRenderer{
		input: &renderInput,
		bundle: runtimeprep.SkillBundle{
			SchemaVersion:  1,
			AgentTargetID:  agenttargetbiz.IDLocalCodex,
			Provider:       "codex",
			AgentSessionID: "run-1",
			CLICommand:     "tutti-dev",
			Skills: []runtimeprep.SkillMaterializationRecord{
				{SkillID: "tutti/tutti-cli", Slug: "tutti-cli", DeliveryMode: "materialized-files"},
			},
		},
	}

	bundle, err := service.GetSkillBundle(context.Background(), "ws-1", SkillBundleInput{
		AgentSessionID: "run-1",
		AgentTargetID:  agenttargetbiz.IDLocalCodex,
		BrowserUse:     true,
	})
	if err != nil {
		t.Fatalf("GetSkillBundle returned error: %v", err)
	}
	if renderInput.WorkspaceID != "ws-1" ||
		renderInput.AgentSessionID != "run-1" ||
		renderInput.AgentTargetID != agenttargetbiz.IDLocalCodex ||
		renderInput.Provider != "codex" ||
		!renderInput.BrowserUse ||
		renderInput.ComputerUse {
		t.Fatalf("render input = %#v", renderInput)
	}
	if bundle.CLICommand != "tutti-dev" || len(bundle.Skills) != 1 || bundle.Skills[0].SkillID != "tutti/tutti-cli" {
		t.Fatalf("bundle = %#v", bundle)
	}
	if len(runtime.startCalls) != 0 {
		t.Fatalf("runtime start calls = %d, want 0", len(runtime.startCalls))
	}
}

func TestServiceGetSkillBundleRequiresRenderer(t *testing.T) {
	runtime := newFakeRuntime()
	service := newIsolatedAgentService(runtime)
	service.AgentTargetStore = fakeAgentTargetStore{targets: map[string]agenttargetbiz.Target{}}
	service.RuntimePreparer = fakeRuntimePreparer{}

	_, err := service.GetSkillBundle(context.Background(), "ws-1", SkillBundleInput{AgentTargetID: "missing:agent"})
	if !errors.Is(err, ErrSkillBundleUnavailable) {
		t.Fatalf("GetSkillBundle error = %v, want ErrSkillBundleUnavailable", err)
	}
	if len(runtime.startCalls) != 0 {
		t.Fatalf("runtime start calls = %d, want 0", len(runtime.startCalls))
	}
}

func TestServiceDeleteCleansPreparedRuntime(t *testing.T) {
	runtime := newFakeRuntime()
	service := newTestService(runtime)
	installFakeCanonicalSessionStore(service)
	cleanupCalls := make([]runtimeprep.CleanupInput, 0)
	service.RuntimePreparer = fakeRuntimePreparer{
		result:       runtimeprep.PreparedRuntime{Cwd: "/prepared/workdir"},
		cleanupCalls: &cleanupCalls,
	}
	cwd := "/user/workdir"
	session, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentSessionID: "11111111-1111-4111-8111-111111111111",
		AgentTargetID:  agenttargetbiz.IDLocalCodex,
		Cwd:            &cwd,
		Provider:       "codex",
		InitialContent: TextPromptContent("hello"),
	})
	if err != nil {
		t.Fatalf("Create returned error: %v", err)
	}

	removed, err := service.Delete(context.Background(), "ws-1", session.ID)
	if err != nil {
		t.Fatalf("Delete returned error: %v", err)
	}
	if !removed.Removed {
		t.Fatal("Delete removed = false, want true")
	}
	if len(cleanupCalls) != 1 {
		t.Fatalf("cleanup calls = %d, want 1", len(cleanupCalls))
	}
	if cleanupCalls[0].WorkspaceID != "ws-1" || cleanupCalls[0].AgentSessionID != session.ID {
		t.Fatalf("cleanup call = %#v", cleanupCalls[0])
	}
}
