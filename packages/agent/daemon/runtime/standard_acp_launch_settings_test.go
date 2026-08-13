package agentruntime

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
)

func TestNexightSpawnCommandCarriesModelSettings(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name     string
		settings *SessionSettings
		want     []string
	}{
		{
			name:     "spark model adds reasoning summary override",
			settings: &SessionSettings{Model: "gpt-5.3-codex-spark", ReasoningEffort: "high"},
			want: []string{
				nexightACPCommand,
				"--config", "model=gpt-5.3-codex-spark",
				"--config", "model_reasoning_summary=none",
				"--config", "model_reasoning_effort=high",
			},
		},
		{
			name:     "plain model omits reasoning summary override",
			settings: &SessionSettings{Model: "gpt-5.1-codex", ReasoningEffort: "medium"},
			want: []string{
				nexightACPCommand,
				"--config", "model=gpt-5.1-codex",
				"--config", "model_reasoning_effort=medium",
			},
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			transport := newStandardACPTransport("Nexight", "nexight-session-1")
			adapter := NewNexightAdapter(transport)
			session := standardTestSession(ProviderNexight)
			session.Settings = tc.settings
			if _, err := adapter.Start(context.Background(), session); err != nil {
				t.Fatalf("Start: %v", err)
			}
			transport.mu.Lock()
			specs := append([]ProcessSpec(nil), transport.specs...)
			transport.mu.Unlock()
			if len(specs) != 1 {
				t.Fatalf("specs = %#v, want one process spawn", specs)
			}
			if !reflect.DeepEqual(specs[0].Command, tc.want) {
				t.Fatalf("spawn command = %#v, want %#v", specs[0].Command, tc.want)
			}
		})
	}
}

func TestNexightRequiresNewSessionWhenReasoningSummaryOverrideChanges(t *testing.T) {
	t.Parallel()

	adapter := NewNexightAdapter(nil)
	session := standardTestSession(ProviderNexight)
	session.Settings = &SessionSettings{Model: "gpt-5.1-codex"}

	sparkModel := "gpt-5.3-codex-spark"
	if !adapter.RequiresNewSessionForSettings(session, SessionSettingsPatch{Model: &sparkModel}) {
		t.Fatal("switching to a spark-family model must force a new session (spawn-time model_reasoning_summary override)")
	}
	plainModel := "gpt-5.2-codex"
	if adapter.RequiresNewSessionForSettings(session, SessionSettingsPatch{Model: &plainModel}) {
		t.Fatal("plain-to-plain model change must not force a new session")
	}
	if adapter.RequiresNewSessionForSettings(session, SessionSettingsPatch{}) {
		t.Fatal("empty patch must not force a new session")
	}
}

func TestStandardACPSpawnCommandUnchangedForOtherProviders(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Hermes Agent", "hermes-session-1")
	adapter := newHermesExtensionTestAdapter(transport)
	session := standardTestSession(hermesExtensionTestProvider)
	session.Settings = &SessionSettings{Model: "gpt-5.3-codex-spark", ReasoningEffort: "high"}
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	transport.mu.Lock()
	specs := append([]ProcessSpec(nil), transport.specs...)
	transport.mu.Unlock()
	if len(specs) != 1 || !reflect.DeepEqual(specs[0].Command, []string{"hermes", "acp"}) {
		t.Fatalf("spawn command = %#v, want bare hermes command", specs)
	}
	sparkModel := "gpt-5.3-codex-spark"
	if adapter.RequiresNewSessionForSettings(session, SessionSettingsPatch{Model: &sparkModel}) {
		t.Fatal("non-nexight providers must not force new sessions for model changes")
	}
}

func TestStandardACPLaunchPermissionBuildsExactArgvAndDoesNotSetWorkflowMode(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		semantic string
		want     string
	}{
		{name: "default", want: "default"},
		{name: "ask", semantic: "ask-before-write", want: "default"},
		{name: "auto", semantic: "auto", want: "auto"},
		{name: "full access", semantic: "full-access", want: "bypassPermissions"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			transport := newStandardACPTransport("Spawn ACP", "spawn-session-1")
			adapterRaw, err := NewStandardACPAdapter(StandardACPAdapterConfig{
				Provider:        "acp:spawn",
				Name:            "spawn-acp",
				DisplayName:     "Spawn ACP",
				Command:         []string{"grok", "--no-auto-update", "--permission-mode", "${permissionMode}", "agent", "stdio"},
				PermissionModes: map[string]string{"ask-before-write": "default", "auto": "auto", "full-access": "bypassPermissions"},
				LaunchPermission: &StandardACPLaunchPermissionSetting{
					Placeholder: "${permissionMode}",
					Values:      map[string]string{"ask-before-write": "default", "auto": "auto", "full-access": "bypassPermissions"},
				},
			}, transport, LegacyHostMetadata())
			if err != nil {
				t.Fatalf("NewStandardACPAdapter: %v", err)
			}
			adapter := adapterRaw.(*standardACPAdapter)
			session := standardTestSession("acp:spawn")
			session.PermissionModeID = tt.semantic
			if _, err := adapter.Start(context.Background(), session); err != nil {
				t.Fatalf("Start: %v", err)
			}
			transport.mu.Lock()
			specs := append([]ProcessSpec(nil), transport.specs...)
			transport.mu.Unlock()
			want := []string{"grok", "--no-auto-update", "--permission-mode", tt.want, "agent", "stdio"}
			if len(specs) != 1 || !reflect.DeepEqual(specs[0].Command, want) {
				t.Fatalf("spawn command = %#v, want %#v", specs, want)
			}
			if got := transport.conn.lastSetModeParams(); got != nil {
				t.Fatalf("session/set_mode params = %#v, want none for spawn-time permission", got)
			}
		})
	}
}

func TestStandardACPLaunchPermissionKeepsPlanAsIndependentWorkflowMode(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Spawn ACP", "spawn-plan-session")
	transport.conn.modes = map[string]any{
		"currentModeId": "default",
		"availableModes": []any{
			map[string]any{"id": "default", "name": "Default"},
			map[string]any{"id": "plan", "name": "Plan"},
		},
	}
	adapterRaw, err := NewStandardACPAdapter(StandardACPAdapterConfig{
		Provider:                  "acp:spawn-plan",
		Name:                      "spawn-plan-acp",
		DisplayName:               "Spawn Plan ACP",
		Command:                   []string{"grok", "--no-auto-update", "--permission-mode", "${permissionMode}", "agent", "stdio"},
		PermissionModes:           map[string]string{"ask-before-write": "default", "auto": "auto", "full-access": "bypassPermissions"},
		PlanModeRuntimeID:         "plan",
		PlanModeDisabledRuntimeID: "default",
		LaunchPermission: &StandardACPLaunchPermissionSetting{
			Placeholder: "${permissionMode}",
			Values:      map[string]string{"ask-before-write": "default", "auto": "auto", "full-access": "bypassPermissions"},
		},
	}, transport, LegacyHostMetadata())
	if err != nil {
		t.Fatalf("NewStandardACPAdapter: %v", err)
	}
	adapter := adapterRaw.(*standardACPAdapter)
	session := standardTestSession("acp:spawn-plan")
	session.PermissionModeID = "full-access"
	session.Settings = &SessionSettings{PermissionModeID: "full-access"}
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if got := transport.conn.lastSetModeParams(); got != nil {
		t.Fatalf("startup session/set_mode = %#v, want none", got)
	}
	for _, enabled := range []bool{true, false} {
		session.Settings.PlanMode = enabled
		if err := adapter.ValidateSessionSettings(session, SessionSettingsPatch{PlanMode: &enabled}); err != nil {
			t.Fatalf("ValidateSessionSettings(%v): %v", enabled, err)
		}
		if err := adapter.ApplySessionSettings(context.Background(), session, SessionSettingsPatch{PlanMode: &enabled}); err != nil {
			t.Fatalf("ApplySessionSettings(%v): %v", enabled, err)
		}
		want := "default"
		if enabled {
			want = "plan"
		}
		if got := transport.conn.lastModeID(); got != want {
			t.Fatalf("plan=%v mode = %q, want %q", enabled, got, want)
		}
	}
	changed := "auto"
	if !adapter.RequiresNewSessionForSettings(session, SessionSettingsPatch{PermissionModeID: &changed}) {
		t.Fatal("spawn-time permission update must require a new session")
	}
	if err := adapter.ApplySessionSettings(context.Background(), session, SessionSettingsPatch{PermissionModeID: &changed}); !errors.Is(err, ErrSessionSettingsRequireNewSession) {
		t.Fatalf("ApplySessionSettings permission error = %v, want ErrSessionSettingsRequireNewSession", err)
	}
}

func TestStandardACPLaunchPermissionWithoutPlanWorkflowNeverSendsPermissionAsMode(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Spawn ACP", "spawn-without-plan-session")
	transport.conn.modes = map[string]any{
		"currentModeId": "default",
		"availableModes": []any{
			map[string]any{"id": "default", "name": "Default"},
			map[string]any{"id": "plan", "name": "Plan"},
		},
	}
	adapterRaw, err := NewStandardACPAdapter(StandardACPAdapterConfig{
		Provider:        "acp:spawn-without-plan",
		Name:            "spawn-without-plan-acp",
		DisplayName:     "Spawn Without Plan ACP",
		Command:         []string{"spawn-acp", "--permission-mode", "${permissionMode}", "agent", "stdio"},
		PermissionModes: map[string]string{"ask-before-write": "default", "auto": "auto", "full-access": "bypassPermissions"},
		LaunchPermission: &StandardACPLaunchPermissionSetting{
			Placeholder: "${permissionMode}",
			Values:      map[string]string{"ask-before-write": "default", "auto": "auto", "full-access": "bypassPermissions"},
		},
	}, transport, LegacyHostMetadata())
	if err != nil {
		t.Fatalf("NewStandardACPAdapter: %v", err)
	}
	adapter := adapterRaw.(*standardACPAdapter)
	session := standardTestSession("acp:spawn-without-plan")
	session.PermissionModeID = "ask-before-write"
	session.Settings = &SessionSettings{PermissionModeID: "ask-before-write", PlanMode: true}
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if got := transport.conn.lastSetModeParams(); got != nil {
		t.Fatalf("startup session/set_mode = %#v, want none", got)
	}
	enabled := true
	if err := adapter.ValidateSessionSettings(session, SessionSettingsPatch{PlanMode: &enabled}); err == nil {
		t.Fatal("ValidateSessionSettings error = nil, want missing signed Plan mapping")
	}
}

func TestStandardACPDeclaredPlanModesDoNotRequireRuntimeModeCatalog(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Declared Plan ACP", "declared-plan-session")
	adapterRaw, err := NewStandardACPAdapter(StandardACPAdapterConfig{
		Provider:                  "acp:declared-plan",
		Name:                      "declared-plan-acp",
		DisplayName:               "Declared Plan ACP",
		Command:                   []string{"declared-plan", "agent", "stdio"},
		PermissionModes:           map[string]string{"ask-before-write": "default"},
		PlanModeRuntimeID:         "plan",
		PlanModeDisabledRuntimeID: "default",
	}, transport, LegacyHostMetadata())
	if err != nil {
		t.Fatalf("NewStandardACPAdapter: %v", err)
	}
	adapter := adapterRaw.(*standardACPAdapter)
	session := standardTestSession("acp:declared-plan")
	session.Settings = &SessionSettings{PermissionModeID: "ask-before-write"}
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}

	for _, enabled := range []bool{true, false} {
		if err := adapter.ValidateSessionSettings(session, SessionSettingsPatch{PlanMode: &enabled}); err != nil {
			t.Fatalf("ValidateSessionSettings(%v): %v", enabled, err)
		}
		session.Settings.PlanMode = enabled
		if err := adapter.ApplySessionSettings(context.Background(), session, SessionSettingsPatch{PlanMode: &enabled}); err != nil {
			t.Fatalf("ApplySessionSettings(%v): %v", enabled, err)
		}
		want := "default"
		if enabled {
			want = "plan"
		}
		if got := transport.conn.lastModeID(); got != want {
			t.Fatalf("plan=%v mode = %q, want %q", enabled, got, want)
		}
	}
}

func TestStandardACPDeclaredPlanModeSurfacesRuntimeRejection(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Rejected Plan ACP", "rejected-plan-session")
	adapterRaw, err := NewStandardACPAdapter(StandardACPAdapterConfig{
		Provider:                  "acp:rejected-plan",
		Name:                      "rejected-plan-acp",
		DisplayName:               "Rejected Plan ACP",
		Command:                   []string{"rejected-plan", "agent", "stdio"},
		PermissionModes:           map[string]string{"ask-before-write": "default"},
		PlanModeRuntimeID:         "plan",
		PlanModeDisabledRuntimeID: "default",
	}, transport, LegacyHostMetadata())
	if err != nil {
		t.Fatalf("NewStandardACPAdapter: %v", err)
	}
	adapter := adapterRaw.(*standardACPAdapter)
	session := standardTestSession("acp:rejected-plan")
	session.Settings = &SessionSettings{PermissionModeID: "ask-before-write"}
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	transport.conn.setModeError = &acpError{Code: -32602, Message: "unsupported mode"}
	enabled := true
	session.Settings.PlanMode = enabled
	if err := adapter.ApplySessionSettings(context.Background(), session, SessionSettingsPatch{PlanMode: &enabled}); err == nil {
		t.Fatal("ApplySessionSettings error = nil, want runtime rejection")
	}
}

func TestStandardACPLaunchPermissionPlanRestartsAndLoadsSameSession(t *testing.T) {
	t.Parallel()

	transport := &multiProcStandardACPTransport{
		agentTitle:          "Grok Build",
		sessionID:           "grok-provider-session",
		supportsLoadSession: true,
	}
	adapterRaw, err := NewStandardACPAdapter(StandardACPAdapterConfig{
		Provider:                     "acp:grok-launch-plan",
		Name:                         "grok-launch-plan-acp",
		DisplayName:                  "Grok Build",
		Command:                      []string{"grok", "--permission-mode", "${permissionMode}", "agent", "stdio"},
		PermissionModes:              map[string]string{"ask-before-write": "default", "auto": "auto", "full-access": "bypassPermissions"},
		PlanModeRuntimeID:            "plan",
		PlanModeDisabledRuntimeID:    "default",
		PlanModeUsesLaunchPermission: true,
		LaunchPermission: &StandardACPLaunchPermissionSetting{
			Placeholder:     "${permissionMode}",
			DefaultSemantic: "ask-before-write",
			Values:          map[string]string{"ask-before-write": "default", "auto": "auto", "full-access": "bypassPermissions"},
		},
	}, transport, LegacyHostMetadata())
	if err != nil {
		t.Fatalf("NewStandardACPAdapter: %v", err)
	}
	adapter := adapterRaw.(*standardACPAdapter)
	session := standardTestSession("acp:grok-launch-plan")
	session.PermissionModeID = "auto"
	session.Settings = &SessionSettings{PermissionModeID: "auto"}
	events, err := adapter.Start(context.Background(), session)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	session.ProviderSessionID = events[0].ProviderSessionID

	for _, enabled := range []bool{true, false} {
		if err := adapter.ValidateSessionSettings(session, SessionSettingsPatch{PlanMode: &enabled}); err != nil {
			t.Fatalf("ValidateSessionSettings(%v): %v", enabled, err)
		}
		session.Settings.PlanMode = enabled
		if err := adapter.ApplySessionSettings(context.Background(), session, SessionSettingsPatch{PlanMode: &enabled}); err != nil {
			t.Fatalf("ApplySessionSettings(%v): %v", enabled, err)
		}
		wantDecision := ""
		if enabled {
			wantDecision = "denied"
		}
		if got := adapter.automaticPermissionDecision(session.AgentSessionID); got != wantDecision {
			t.Fatalf("plan=%v automatic permission decision = %q, want %q", enabled, got, wantDecision)
		}
	}

	transport.mu.Lock()
	specs := append([]ProcessSpec(nil), transport.specs...)
	connections := append([]*standardACPConnection(nil), transport.conns...)
	transport.mu.Unlock()
	if len(specs) != 3 {
		t.Fatalf("process starts = %d, want initial plus two Plan restarts", len(specs))
	}
	wantModes := []string{"auto", "plan", "auto"}
	for index, want := range wantModes {
		if got := specs[index].Command[2]; got != want {
			t.Fatalf("process %d permission mode = %q, want %q", index, got, want)
		}
	}
	for index := 1; index < len(connections); index++ {
		if got := asString(connections[index].lastLoadSessionParams["sessionId"]); got != "grok-provider-session" {
			t.Fatalf("restart %d loaded session = %q, want grok-provider-session", index, got)
		}
	}
	spawned, live := transport.snapshot()
	if spawned != 3 || len(live) != 1 {
		t.Fatalf("spawned/live processes = %d/%d, want 3/1", spawned, len(live))
	}
}

func TestStandardACPLaunchPermissionPlanPersistsWithoutSpawnAfterReleaseFailure(t *testing.T) {
	t.Parallel()

	transport := &multiProcStandardACPTransport{
		agentTitle:          "Grok Build",
		sessionID:           "grok-provider-session-deferred-plan",
		supportsLoadSession: true,
	}
	adapterRaw, err := NewStandardACPAdapter(StandardACPAdapterConfig{
		Provider:                     "acp:grok-launch-plan-deferred",
		Name:                         "grok-launch-plan-deferred-acp",
		DisplayName:                  "Grok Build",
		Command:                      []string{"grok", "--permission-mode", "${permissionMode}", "agent", "stdio"},
		PermissionModes:              map[string]string{"ask-before-write": "default", "auto": "auto", "full-access": "bypassPermissions"},
		PlanModeRuntimeID:            "plan",
		PlanModeDisabledRuntimeID:    "default",
		PlanModeUsesLaunchPermission: true,
		LaunchPermission: &StandardACPLaunchPermissionSetting{
			Placeholder:     "${permissionMode}",
			DefaultSemantic: "ask-before-write",
			Values:          map[string]string{"ask-before-write": "default", "auto": "auto", "full-access": "bypassPermissions"},
		},
	}, transport, LegacyHostMetadata())
	if err != nil {
		t.Fatalf("NewStandardACPAdapter: %v", err)
	}
	adapter := adapterRaw.(*standardACPAdapter)
	session := standardTestSession("acp:grok-launch-plan-deferred")
	session.PermissionModeID = "auto"
	session.Settings = &SessionSettings{PermissionModeID: "auto"}
	events, err := adapter.Start(context.Background(), session)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	session.ProviderSessionID = events[0].ProviderSessionID
	transport.mu.Lock()
	firstConnection := transport.conns[0]
	transport.mu.Unlock()
	firstConnection.mu.Lock()
	firstConnection.closeFailures = 1
	firstConnection.mu.Unlock()
	if err := adapter.ReleaseLiveSession(context.Background(), session); err == nil {
		t.Fatal("ReleaseLiveSession error = nil, want injected close failure")
	}

	enabled := true
	session.Settings.PlanMode = enabled
	if err := adapter.ApplySessionSettings(context.Background(), session, SessionSettingsPatch{PlanMode: &enabled}); err != nil {
		t.Fatalf("ApplySessionSettings: %v", err)
	}
	spawned, _ := transport.snapshot()
	if spawned != 1 {
		t.Fatalf("process starts after settings persistence = %d, want 1", spawned)
	}
	if err := adapter.Resume(context.Background(), session); err != nil {
		t.Fatalf("Resume: %v", err)
	}
	transport.mu.Lock()
	specs := append([]ProcessSpec(nil), transport.specs...)
	connections := append([]*standardACPConnection(nil), transport.conns...)
	transport.mu.Unlock()
	if len(specs) != 2 || specs[1].Command[2] != "plan" {
		t.Fatalf("resume command = %#v, want persisted Plan launch", specs)
	}
	if got := asString(connections[1].lastLoadSessionParams["sessionId"]); got != session.ProviderSessionID {
		t.Fatalf("resumed provider session = %q, want %q", got, session.ProviderSessionID)
	}
}

func TestStandardACPLaunchPermissionRejectsUnknownSessionSemantic(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Spawn ACP", "spawn-invalid-session")
	adapterRaw, err := NewStandardACPAdapter(StandardACPAdapterConfig{
		Provider:        "acp:spawn-invalid",
		Name:            "spawn-invalid-acp",
		DisplayName:     "Spawn Invalid ACP",
		Command:         []string{"spawn-acp", "${permissionMode}", "stdio"},
		PermissionModes: map[string]string{"ask-before-write": "ask", "auto": "auto", "full-access": "always-approve"},
		LaunchPermission: &StandardACPLaunchPermissionSetting{
			Placeholder: "${permissionMode}",
			Values:      map[string]string{"ask-before-write": "ask", "auto": "auto", "full-access": "always-approve"},
		},
	}, transport, LegacyHostMetadata())
	if err != nil {
		t.Fatalf("NewStandardACPAdapter: %v", err)
	}
	session := standardTestSession("acp:spawn-invalid")
	session.PermissionModeID = "unknown"
	if _, err := adapterRaw.Start(context.Background(), session); err == nil {
		t.Fatal("Start unknown permission semantic error = nil")
	}
	transport.mu.Lock()
	defer transport.mu.Unlock()
	if len(transport.specs) != 0 {
		t.Fatalf("spawn specs = %#v, want fail before process start", transport.specs)
	}
}

func TestStandardACPSessionNewAndLoadPassStandardClientMCPConfig(t *testing.T) {
	t.Parallel()

	newTransport := newStandardACPTransport("MCP ACP", "mcp-new-session")
	newAdapterRaw, err := NewStandardACPAdapter(StandardACPAdapterConfig{
		Provider: "acp:mcp-new", Name: "mcp-new-acp", DisplayName: "MCP ACP", Command: []string{"mcp-acp", "stdio"},
	}, newTransport, LegacyHostMetadata())
	if err != nil {
		t.Fatalf("NewStandardACPAdapter new: %v", err)
	}
	newSession := standardTestSession("acp:mcp-new")
	newSession.MCPServers = []MCPServerBinding{{Name: "connector", Type: "http", URL: "http://127.0.0.1:1234/mcp/connector",
		Headers: map[string]string{"Authorization": "Bearer test-token"}}}
	if _, err := newAdapterRaw.Start(context.Background(), newSession); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if servers, ok := newTransport.conn.lastNewSessionParams["mcpServers"].([]any); !ok || len(servers) != 1 {
		t.Fatalf("session/new mcpServers = %#v, want connector binding", newTransport.conn.lastNewSessionParams["mcpServers"])
	}

	loadTransport := newStandardACPTransport("MCP ACP", "mcp-load-session")
	loadTransport.conn.supportsLoadSession = true
	loadAdapterRaw, err := NewStandardACPAdapter(StandardACPAdapterConfig{
		Provider: "acp:mcp-load", Name: "mcp-load-acp", DisplayName: "MCP ACP", Command: []string{"mcp-acp", "stdio"},
	}, loadTransport, LegacyHostMetadata())
	if err != nil {
		t.Fatalf("NewStandardACPAdapter load: %v", err)
	}
	loadSession := standardTestSession("acp:mcp-load")
	loadSession.ProviderSessionID = "mcp-load-session"
	loadSession.MCPServers = cloneMCPServerBindings(newSession.MCPServers)
	if err := loadAdapterRaw.Resume(context.Background(), loadSession); err != nil {
		t.Fatalf("Resume: %v", err)
	}
	if servers, ok := loadTransport.conn.lastLoadSessionParams["mcpServers"].([]any); !ok || len(servers) != 1 {
		t.Fatalf("session/load mcpServers = %#v, want connector binding", loadTransport.conn.lastLoadSessionParams["mcpServers"])
	}
}

func TestStandardACPSessionFallsBackWithoutHTTPMCPWhenAgentDoesNotAdvertiseCapability(t *testing.T) {
	t.Parallel()

	newTransport := newStandardACPTransport("MCP Unsupported ACP", "mcp-unsupported-session")
	newTransport.conn.supportsHTTPMCP = false
	newAdapter, err := NewStandardACPAdapter(StandardACPAdapterConfig{
		Provider: "acp:mcp-unsupported", Name: "mcp-unsupported-acp", DisplayName: "MCP Unsupported ACP", Command: []string{"mcp-acp", "stdio"},
	}, newTransport, LegacyHostMetadata())
	if err != nil {
		t.Fatalf("NewStandardACPAdapter: %v", err)
	}
	session := standardTestSession("acp:mcp-unsupported")
	session.MCPServers = []MCPServerBinding{{Name: "connector", Type: "http", URL: "http://127.0.0.1:1234/mcp/connector"}}
	if _, err := newAdapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start error = %v", err)
	}
	if servers, ok := newTransport.conn.lastNewSessionParams["mcpServers"].([]any); ok && len(servers) != 0 {
		t.Fatalf("session/new mcpServers = %#v, want empty fallback", newTransport.conn.lastNewSessionParams["mcpServers"])
	}

	loadTransport := newStandardACPTransport("MCP Unsupported ACP", "mcp-unsupported-load-session")
	loadTransport.conn.supportsHTTPMCP = false
	loadTransport.conn.supportsLoadSession = true
	loadAdapter, err := NewStandardACPAdapter(StandardACPAdapterConfig{
		Provider: "acp:mcp-unsupported", Name: "mcp-unsupported-acp", DisplayName: "MCP Unsupported ACP", Command: []string{"mcp-acp", "stdio"},
	}, loadTransport, LegacyHostMetadata())
	if err != nil {
		t.Fatalf("NewStandardACPAdapter load: %v", err)
	}
	loadSession := standardTestSession("acp:mcp-unsupported")
	loadSession.ProviderSessionID = "mcp-unsupported-load-session"
	loadSession.MCPServers = cloneMCPServerBindings(session.MCPServers)
	if err := loadAdapter.Resume(context.Background(), loadSession); err != nil {
		t.Fatalf("Resume error = %v", err)
	}
	if servers, ok := loadTransport.conn.lastLoadSessionParams["mcpServers"].([]any); ok && len(servers) != 0 {
		t.Fatalf("session/load mcpServers = %#v, want empty fallback", loadTransport.conn.lastLoadSessionParams["mcpServers"])
	}
}

func TestStandardACPConnectorCapabilitiesRequireExplicitHTTPDeclaration(t *testing.T) {
	t.Parallel()

	for _, test := range []struct {
		name      string
		supported bool
	}{
		{name: "declared", supported: true},
		{name: "missing", supported: false},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			transport := newStandardACPTransport("Capability ACP", "capability-session")
			transport.conn.supportsHTTPMCP = test.supported
			adapter, err := NewStandardACPAdapter(StandardACPAdapterConfig{
				Provider: "acp:capability", Name: "capability-acp", DisplayName: "Capability ACP", Command: []string{"capability-acp", "stdio"},
			}, transport, LegacyHostMetadata())
			if err != nil {
				t.Fatalf("NewStandardACPAdapter: %v", err)
			}
			capabilities, err := adapter.(ConnectorCapabilityAdapter).ConnectorCapabilities(t.Context(), standardTestSession("acp:capability"))
			if err != nil {
				t.Fatalf("ConnectorCapabilities: %v", err)
			}
			if capabilities.HTTPMCP != test.supported {
				t.Fatalf("HTTPMCP = %v, want %v", capabilities.HTTPMCP, test.supported)
			}
			if transport.conn.lastNewSessionParams != nil {
				t.Fatalf("capability probe created session: %#v", transport.conn.lastNewSessionParams)
			}
		})
	}
}

func TestStandardACPSetModelCarriesAdvertisedPerModelReasoningMetadata(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Model ACP", "model-session")
	transport.conn.models = map[string]any{
		"currentModelId": "reasoning-model",
		"availableModels": []any{
			map[string]any{
				"modelId": "reasoning-model", "name": "Reasoning Model",
				"supportsReasoningEffort": true, "reasoningEffort": "deep",
				"reasoningEfforts": []any{
					map[string]any{"value": "brief", "label": "Brief"},
					map[string]any{"value": "deep", "label": "Deep", "default": true},
				},
			},
			map[string]any{"modelId": "plain-model", "name": "Plain Model", "supportsReasoningEffort": false, "reasoningEfforts": []any{}},
		},
	}
	adapterRaw, err := NewStandardACPAdapter(StandardACPAdapterConfig{
		Provider:                    "acp:model-meta",
		Name:                        "model-meta-acp",
		DisplayName:                 "Model ACP",
		Command:                     []string{"model-acp", "stdio"},
		SetModelReasoningEffortMeta: true,
	}, transport, LegacyHostMetadata())
	if err != nil {
		t.Fatalf("NewStandardACPAdapter: %v", err)
	}
	adapter := adapterRaw.(*standardACPAdapter)
	session := standardTestSession("acp:model-meta")
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}

	session.Settings = &SessionSettings{Model: "reasoning-model", ReasoningEffort: "brief"}
	brief := "brief"
	if err := adapter.ValidateSessionSettings(session, SessionSettingsPatch{ReasoningEffort: &brief}); err != nil {
		t.Fatalf("ValidateSessionSettings reasoning: %v", err)
	}
	if err := adapter.ApplySessionSettings(context.Background(), session, SessionSettingsPatch{ReasoningEffort: &brief}); err != nil {
		t.Fatalf("ApplySessionSettings reasoning: %v", err)
	}
	calls := transport.conn.setModelCalls()
	if len(calls) != 1 || calls[0]["modelId"] != "reasoning-model" {
		t.Fatalf("set_model calls = %#v, want reasoning-model", calls)
	}
	if meta := payloadObject(calls[0]["_meta"]); meta["reasoningEffort"] != "brief" {
		t.Fatalf("set_model _meta = %#v, want brief", meta)
	}

	plain := "plain-model"
	session.Settings = &SessionSettings{Model: plain, ReasoningEffort: "brief"}
	if err := adapter.ValidateSessionSettings(session, SessionSettingsPatch{Model: &plain}); err != nil {
		t.Fatalf("ValidateSessionSettings plain model: %v", err)
	}
	if err := adapter.ApplySessionSettings(context.Background(), session, SessionSettingsPatch{Model: &plain}); err != nil {
		t.Fatalf("ApplySessionSettings plain model: %v", err)
	}
	calls = transport.conn.setModelCalls()
	if len(calls) != 2 || calls[1]["modelId"] != plain {
		t.Fatalf("set_model calls = %#v, want plain-model second", calls)
	}
	if _, exists := calls[1]["_meta"]; exists {
		t.Fatalf("plain model set_model = %#v, want no reasoning metadata", calls[1])
	}
	unsupported := "brief"
	if err := adapter.ValidateSessionSettings(session, SessionSettingsPatch{ReasoningEffort: &unsupported}); err == nil {
		t.Fatal("unsupported model reasoning validation error = nil")
	}
	if calls := transport.conn.setConfigOptionCalls(); len(calls) != 0 {
		t.Fatalf("config option calls = %#v, want standard session/set_model only", calls)
	}
}

func TestStandardACPStartupFailsWhenRequestedModelIsRejected(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Model ACP", "model-rejected-session")
	transport.conn.models = map[string]any{
		"currentModelId": "provider-default",
		"availableModels": []any{
			map[string]any{"modelId": "requested-model", "name": "Requested Model"},
		},
	}
	transport.conn.setModelError = &acpError{
		Code:    -32603,
		Message: "Internal error",
		Data:    json.RawMessage(`{"details":"requested model is unavailable"}`),
	}
	adapterRaw, err := NewStandardACPAdapter(StandardACPAdapterConfig{
		Provider: "acp:model-rejected", Name: "model-rejected-acp", DisplayName: "Model ACP", Command: []string{"model-acp", "stdio"},
	}, transport, LegacyHostMetadata())
	if err != nil {
		t.Fatalf("NewStandardACPAdapter: %v", err)
	}
	session := standardTestSession("acp:model-rejected")
	session.Settings = &SessionSettings{Model: "requested-model"}

	if _, err := adapterRaw.Start(context.Background(), session); err == nil {
		t.Fatal("Start error = nil, want rejected requested model to abort startup")
	} else if !strings.Contains(err.Error(), "model configuration failed") {
		t.Fatalf("Start error = %v, want model configuration failure", err)
	}
}

func TestStandardACPStartupDoesNotReapplyCurrentRequestedModel(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Model ACP", "model-current-session")
	transport.conn.models = map[string]any{
		"currentModelId": "requested-model",
		"availableModels": []any{
			map[string]any{"modelId": "requested-model", "name": "Requested Model"},
		},
	}
	transport.conn.setModelError = &acpError{
		Code: -32603, Message: "duplicate model application rejected",
	}
	adapterRaw, err := NewStandardACPAdapter(StandardACPAdapterConfig{
		Provider: "acp:model-current", Name: "model-current-acp", DisplayName: "Model ACP", Command: []string{"model-acp", "stdio"},
	}, transport, LegacyHostMetadata())
	if err != nil {
		t.Fatalf("NewStandardACPAdapter: %v", err)
	}
	session := standardTestSession("acp:model-current")
	session.Settings = &SessionSettings{Model: "requested-model"}

	if _, err := adapterRaw.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if calls := transport.conn.setModelCalls(); len(calls) != 0 {
		t.Fatalf("set_model calls = %#v, want current model left unchanged", calls)
	}
}
