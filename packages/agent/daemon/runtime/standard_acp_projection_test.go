package agentruntime

import (
	"context"
	"runtime"
	"strings"
	"testing"
)

func TestOpenStandardACPAdapterCacheFailsClosedAcrossTargetBindings(t *testing.T) {
	resolveCWD := t.TempDir()
	adapter, err := NewStandardACPAdapter(StandardACPAdapterConfig{
		Provider:          "acp:example",
		Name:              "example-acp",
		Command:           []string{"example", "--acp"},
		ProviderTargetID:  "extension:example-a",
		InstallationID:    "example@1.0.0",
		AdapterResolveCWD: resolveCWD,
	}, nil, LegacyHostMetadata())
	if err != nil {
		t.Fatalf("NewStandardACPAdapter: %v", err)
	}
	controller := NewController([]Adapter{adapter}, nil)
	exact := AdapterResolveInput{
		Provider:      "acp:example",
		AgentTargetID: "extension:example-a",
		CWD:           resolveCWD,
		ProviderTargetRef: map[string]any{
			"kind":                    "agent_extension",
			"targetId":                "extension:example-a",
			"extensionInstallationId": "example@1.0.0",
		},
	}
	resolved, err := controller.resolveAdapter(context.Background(), exact)
	if err != nil || resolved != adapter {
		t.Fatalf("exact binding resolved adapter = %#v, error = %v", resolved, err)
	}
	sharedHarness := exact
	sharedHarness.AgentTargetID = "workspace-agent:reviewer"
	resolved, err = controller.resolveAdapter(context.Background(), sharedHarness)
	if err != nil || resolved != adapter {
		t.Fatalf("shared Harness binding resolved adapter = %#v, error = %v", resolved, err)
	}
	if runtime.GOOS == "windows" {
		windowsPathVariant := sharedHarness
		windowsPathVariant.CWD = strings.ToUpper(strings.ReplaceAll(resolveCWD, `\`, "/")) + "/"
		resolved, err = controller.resolveAdapter(context.Background(), windowsPathVariant)
		if err != nil || resolved != adapter {
			t.Fatalf("Windows path variant resolved adapter = %#v, error = %v", resolved, err)
		}
	}

	tests := []struct {
		name  string
		input AdapterResolveInput
	}{
		{
			name: "project root",
			input: AdapterResolveInput{
				Provider:      exact.Provider,
				AgentTargetID: exact.AgentTargetID,
				CWD:           t.TempDir(),
				ProviderTargetRef: map[string]any{
					"kind":                    "agent_extension",
					"targetId":                "extension:example-a",
					"extensionInstallationId": "example@1.0.0",
				},
			},
		},
		{
			name: "target",
			input: AdapterResolveInput{
				Provider:      exact.Provider,
				AgentTargetID: exact.AgentTargetID,
				CWD:           exact.CWD,
				ProviderTargetRef: map[string]any{
					"kind":                    "agent_extension",
					"targetId":                "extension:example-b",
					"extensionInstallationId": "example@1.0.0",
				},
			},
		},
		{
			name: "installation",
			input: AdapterResolveInput{
				Provider:      exact.Provider,
				AgentTargetID: exact.AgentTargetID,
				CWD:           exact.CWD,
				ProviderTargetRef: map[string]any{
					"kind":                    "agent_extension",
					"targetId":                "extension:example-a",
					"extensionInstallationId": "example@2.0.0",
				},
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := controller.resolveAdapter(context.Background(), tt.input); err == nil ||
				!strings.Contains(err.Error(), "cached adapter binding mismatch") {
				t.Fatalf("resolveAdapter error = %v, want binding mismatch", err)
			}
		})
	}
}

func TestNormalizeAdapterResolveCWDUsesPlatformPathIdentity(t *testing.T) {
	tests := []struct {
		name  string
		left  string
		right string
		goos  string
		want  bool
	}{
		{name: "Windows drive path accepts separator variants", left: `C:\Workspace\Project\`, right: `c:/workspace/project`, goos: "windows", want: true},
		{name: "Windows UNC path accepts separator variants", left: `\\Server\Share\Project\`, right: `//server/share/project`, goos: "windows", want: true},
		{name: "Windows relative path accepts separator variants", left: `Workspace\Project\`, right: `workspace/project`, goos: "windows", want: true},
		{name: "Windows root-relative path accepts separator variants", left: `\Workspace\Project\`, right: `\workspace/project`, goos: "windows", want: true},
		{name: "Windows root path differs from empty path", left: `\`, right: "", goos: "windows", want: false},
		{name: "Windows drive root differs from drive relative path", left: `C:\`, right: `C:`, goos: "windows", want: false},
		{name: "POSIX path is case sensitive", left: "/Workspace/Project", right: "/workspace/project", goos: "darwin", want: false},
		{name: "POSIX logical path remains case sensitive on Windows", left: "/Workspace/Project", right: "/workspace/project", goos: "windows", want: false},
		{name: "parent traversal remains part of command identity", left: `C:\workspace\link\..\project`, right: `C:/workspace/project`, goos: "windows", want: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := normalizeAdapterResolveCWDForPlatform(tt.left, tt.goos) ==
				normalizeAdapterResolveCWDForPlatform(tt.right, tt.goos)
			if got != tt.want {
				t.Fatalf("path identity = %t, want %t", got, tt.want)
			}
		})
	}
}

func TestStandardACPUsesSignedConfigOptionIDsForReadAndWrite(t *testing.T) {
	transport := newStandardACPTransport("Example Agent", "example-session-1")
	transport.conn.configOptions = []map[string]any{
		{
			"id":           "model-choice",
			"currentValue": "example-basic",
			"options": []any{
				map[string]any{"name": "Basic", "value": "example-basic"},
				map[string]any{"name": "Pro", "value": "example-pro"},
			},
		},
		{
			"id":           "thought-level",
			"currentValue": "medium",
			"options": []any{
				map[string]any{"name": "Medium", "value": "medium"},
				map[string]any{"name": "Deep", "value": "deep"},
			},
		},
	}
	adapterRaw, err := NewStandardACPAdapter(StandardACPAdapterConfig{
		Provider:                "acp:example",
		Name:                    "example-acp",
		Command:                 []string{"example", "--acp"},
		ModelConfigOptionID:     "model-choice",
		ReasoningConfigOptionID: "thought-level",
		RestrictConfigOptions:   true,
	}, transport, LegacyHostMetadata())
	if err != nil {
		t.Fatalf("NewStandardACPAdapter: %v", err)
	}
	adapter := adapterRaw.(*standardACPAdapter)
	session := standardTestSession("acp:example")
	session.Settings = &SessionSettings{Model: "example-pro", ReasoningEffort: "deep"}
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	calls := transport.conn.setConfigOptionCalls()
	if len(calls) != 2 || asString(calls[0]["configId"]) != "model-choice" || asString(calls[1]["configId"]) != "thought-level" {
		t.Fatalf("config option calls = %#v, want signed model/reasoning ids", calls)
	}
	snapshot := adapter.SessionState(session)
	if snapshot.Settings == nil || snapshot.Settings.Model != "example-pro" || snapshot.Settings.ReasoningEffort != "deep" {
		t.Fatalf("session settings = %#v, want signed config values", snapshot.Settings)
	}
}

func TestOpenStandardACPReasoningAliasesRoundTripCanonicalProjectionAndRuntimeWrite(t *testing.T) {
	for _, runtimeID := range []string{"reasoning_effort", "model_reasoning_effort", "effort", "thought_level"} {
		runtimeID := runtimeID
		t.Run(runtimeID, func(t *testing.T) {
			transport := newStandardACPTransport("Example Agent", "example-session-1")
			transport.conn.configOptions = []map[string]any{{
				"id":           runtimeID,
				"currentValue": "medium",
				"options": []any{
					map[string]any{"name": "Medium", "value": "medium"},
					map[string]any{"name": "High", "value": "high"},
				},
			}}
			adapterRaw, err := NewStandardACPAdapter(StandardACPAdapterConfig{
				Provider: "acp:example",
				Name:     "example-acp",
				Command:  []string{"example", "--acp"},
			}, transport, LegacyHostMetadata())
			if err != nil {
				t.Fatalf("NewStandardACPAdapter: %v", err)
			}
			adapter := adapterRaw.(*standardACPAdapter)
			session := standardTestSession("acp:example")
			session.Settings = &SessionSettings{ReasoningEffort: "high"}
			if _, err := adapter.Start(context.Background(), session); err != nil {
				t.Fatalf("Start: %v", err)
			}
			calls := transport.conn.setConfigOptionCalls()
			if len(calls) != 1 || asString(calls[0]["configId"]) != runtimeID {
				t.Fatalf("config calls = %#v, want runtime id %q", calls, runtimeID)
			}
			state := adapter.SessionState(session)
			descriptors, _ := state.RuntimeContext["configOptions"].([]map[string]any)
			projected := configOptionByID(descriptors, "reasoning_effort")
			if projected == nil {
				t.Fatalf("configOptions = %#v, want canonical reasoning_effort", descriptors)
			}
			if runtimeID != "reasoning_effort" && asString(projected["runtimeId"]) != runtimeID {
				t.Fatalf("projected runtimeId = %#v, want %q", projected["runtimeId"], runtimeID)
			}
		})
	}
}

func TestCanonicalACPReasoningAliasPrecedenceIsDeterministicAndPreservesUnknownOptions(t *testing.T) {
	orders := [][]map[string]any{
		{{"id": "thought_level", "currentValue": "deep"}, {"id": "effort", "currentValue": "high"}, {"id": "sandbox", "currentValue": "strict"}},
		{{"id": "sandbox", "currentValue": "strict"}, {"id": "effort", "currentValue": "high"}, {"id": "thought_level", "currentValue": "deep"}},
	}
	for _, descriptors := range orders {
		projected := canonicalACPConfigOptionDescriptorsForRuntimeContext(descriptors)
		reasoning := configOptionByID(projected, "reasoning_effort")
		if reasoning == nil || asString(reasoning["runtimeId"]) != "effort" || asString(reasoning["currentValue"]) != "high" {
			t.Fatalf("projected descriptors = %#v, want effort alias precedence", projected)
		}
		if configOptionByID(projected, "sandbox") == nil {
			t.Fatalf("projected descriptors = %#v, want unknown sandbox option preserved", projected)
		}
	}
}

func TestOpenStandardACPSettingsValidationRejectsUnadvertisedValuesBeforeWrites(t *testing.T) {
	transport := newStandardACPTransport("Example Agent", "example-session-1")
	transport.conn.configOptions = []map[string]any{
		{
			"id":           "model",
			"currentValue": "example-pro",
			"options": []any{
				map[string]any{"name": "Example Pro", "value": "example-pro"},
				map[string]any{"name": "Example Fast", "value": "example-fast"},
			},
		},
		{
			"id":           "mode",
			"currentValue": "default",
			"options": []any{
				map[string]any{"name": "Default", "value": "default"},
				map[string]any{"name": "Automatic", "value": "auto"},
			},
		},
		{
			"id":           "effort",
			"currentValue": "medium",
			"options": []any{
				map[string]any{"name": "Medium", "value": "medium"},
				map[string]any{"name": "High", "value": "high"},
			},
		},
	}
	adapter, err := NewStandardACPAdapter(StandardACPAdapterConfig{
		Provider: "acp:example",
		Name:     "example-acp",
		Command:  []string{"example", "--acp"},
		PermissionModes: map[string]string{
			"ask-before-write": "default",
			"auto":             "auto",
		},
	}, transport, LegacyHostMetadata())
	if err != nil {
		t.Fatalf("NewStandardACPAdapter: %v", err)
	}
	controller := NewController([]Adapter{adapter}, nil)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:           "room-1",
		AgentSessionID:   "session-1",
		Provider:         "acp:example",
		CWD:              "/workspace",
		PermissionModeID: "ask-before-write",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	invalidMode := "full-access"
	if _, err := controller.UpdateSettings(context.Background(), UpdateSettingsInput{
		RoomID: started.Session.RoomID, AgentSessionID: started.Session.AgentSessionID,
		Settings: SessionSettingsPatch{PermissionModeID: &invalidMode},
	}); err == nil {
		t.Fatal("UpdateSettings invalid permission mode error = nil")
	}
	invalidReasoning := "extreme"
	if _, err := controller.UpdateSettings(context.Background(), UpdateSettingsInput{
		RoomID: started.Session.RoomID, AgentSessionID: started.Session.AgentSessionID,
		Settings: SessionSettingsPatch{ReasoningEffort: &invalidReasoning},
	}); err == nil {
		t.Fatal("UpdateSettings invalid reasoning value error = nil")
	}
	invalidModel := "unadvertised-model"
	if _, err := controller.UpdateSettings(context.Background(), UpdateSettingsInput{
		RoomID: started.Session.RoomID, AgentSessionID: started.Session.AgentSessionID,
		Settings: SessionSettingsPatch{Model: &invalidModel},
	}); err == nil {
		t.Fatal("UpdateSettings invalid model error = nil")
	}
	validModel := "example-fast"
	if _, err := controller.UpdateSettings(context.Background(), UpdateSettingsInput{
		RoomID: started.Session.RoomID, AgentSessionID: started.Session.AgentSessionID,
		Settings: SessionSettingsPatch{Model: &validModel},
	}); err != nil {
		t.Fatalf("UpdateSettings advertised model error = %v", err)
	}
	validReasoning := "high"
	if _, err := controller.UpdateSettings(context.Background(), UpdateSettingsInput{
		RoomID: started.Session.RoomID, AgentSessionID: started.Session.AgentSessionID,
		Settings: SessionSettingsPatch{ReasoningEffort: &validReasoning},
	}); err != nil {
		t.Fatalf("UpdateSettings advertised reasoning error = %v", err)
	}
	stored, ok := controller.Session(started.Session.RoomID, started.Session.AgentSessionID)
	if !ok || stored.PermissionModeID != "ask-before-write" {
		t.Fatalf("stored session = %#v, want original permission mode", stored)
	}
}

func TestApplyACPModesResultProjectsRuntimeModeCatalog(t *testing.T) {
	state := newACPLiveState()
	applyACPModesResult(&state, []byte(`{
		"modes": {
			"currentModeId": "default",
			"availableModes": [
				{"id":"default","name":"Default","description":"Ask first"},
				{"id":"auto","name":"Automatic"}
			]
		}
	}`))
	if state.currentMode != "default" || !acpConfigOptionAdvertisesValue(state, "mode", "auto") {
		t.Fatalf("mode live state = %#v, want advertised runtime modes", state)
	}
}
