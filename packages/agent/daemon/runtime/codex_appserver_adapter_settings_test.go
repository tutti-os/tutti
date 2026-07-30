package agentruntime

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"sync"
	"testing"
)

func TestCodexAppServerAdapterApplySessionSettings(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	model := "gpt-5.1-codex-mini"
	effort := "low"
	if adapter.RequiresNewSessionForSettings(session, SessionSettingsPatch{Model: &model}) {
		t.Fatalf("RequiresNewSessionForSettings = true, want false (per-turn overrides)")
	}
	if err := adapter.ApplySessionSettings(context.Background(), session, SessionSettingsPatch{
		Model:           &model,
		ReasoningEffort: &effort,
	}); err != nil {
		t.Fatalf("ApplySessionSettings: %v", err)
	}
	state := adapter.SessionState(session)
	config, _ := state.RuntimeContext["config"].(map[string]any)
	if asString(config["model"]) != model || asString(config["reasoning_effort"]) != "low" {
		t.Fatalf("config = %#v", config)
	}

	session.Settings = &SessionSettings{Model: model, ReasoningEffort: effort}
	if _, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "go",
	}}, "", "turn-local-1", nil, nil); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	turnStart := appServerRequestParams(t, transport.conn, appServerMethodTurnStart)
	if asString(turnStart["model"]) != model || asString(turnStart["effort"]) != "low" {
		t.Fatalf("turn/start overrides = %#v", turnStart)
	}
}

func TestCodexAppServerAdapterApplySessionSettingsRefreshesModelReasoningOptions(t *testing.T) {
	t.Parallel()

	adapter, _, session := startedAppServerAdapter(t)
	adapter.mu.Lock()
	appSession := adapter.sessions[session.AgentSessionID]
	appSession.models = []map[string]any{
		{
			"id":                        "gpt-5.6-sol",
			"supportedReasoningEfforts": []any{"low", "medium", "high", "xhigh", "max", "ultra"},
		},
		{
			"id":                        "gpt-5.6-luna",
			"defaultReasoningEffort":    "high",
			"supportedReasoningEfforts": []any{"low", "medium", "high", "xhigh", "max"},
		},
	}
	adapter.mu.Unlock()
	session.Settings = &SessionSettings{Model: "gpt-5.6-luna", ReasoningEffort: "ultra"}
	model := "gpt-5.6-luna"

	if err := adapter.ApplySessionSettings(context.Background(), session, SessionSettingsPatch{
		Model: &model,
	}); err != nil {
		t.Fatalf("ApplySessionSettings: %v", err)
	}
	state := adapter.SessionState(session)
	options, _ := state.RuntimeContext["configOptions"].([]map[string]any)
	modelConfig := configOptionByID(options, "model")
	modelOptions := configOptionEntries(modelConfig["options"])
	if len(modelOptions) != 2 {
		t.Fatalf("model options = %#v, want two capability-bearing models", modelOptions)
	}
	firstModelEfforts := configOptionEntries(modelOptions[0]["reasoningEfforts"])
	gotModelEfforts := make([]string, 0, len(firstModelEfforts))
	for _, effort := range firstModelEfforts {
		gotModelEfforts = append(gotModelEfforts, asString(effort["value"]))
	}
	if !slices.Equal(gotModelEfforts, []string{"low", "medium", "high", "xhigh", "max", "ultra"}) {
		t.Fatalf("first model reasoning options = %#v, want full Sol profile; raw=%#v", gotModelEfforts, firstModelEfforts)
	}
	if modelOptions[0]["supportsReasoningEffort"] != true || asString(modelOptions[0]["reasoningEffort"]) != "low" {
		t.Fatalf("first model reasoning metadata = %#v", modelOptions[0])
	}
	reasoning := configOptionByID(options, "reasoning_effort")
	if got := configOptionValues(reasoning); !slices.Equal(got, []string{"low", "medium", "high", "xhigh", "max"}) {
		t.Fatalf("reasoning options = %#v, want Luna efforts without ultra", got)
	}
	if got := asString(reasoning["currentValue"]); got != "high" {
		t.Fatalf("reasoning current value = %q, want high", got)
	}
}

func TestCodexAppServerAdapterExecStateSnapshotOwnsMutableSettings(t *testing.T) {
	t.Parallel()

	adapter, _, session := startedAppServerAdapter(t)
	adapter.mu.Lock()
	appSession := adapter.sessions[session.AgentSessionID]
	appSession.models = []map[string]any{{
		"model":                     "gpt-5.6-sol",
		"supportedReasoningEfforts": []any{"high", "ultra"},
	}}
	appSession.configOptions = map[string]any{
		"model":            "gpt-5.6-sol",
		"reasoning_effort": "ultra",
		"nested":           map[string]any{"value": "original"},
	}
	appSession.defaultModel = "gpt-5.6-sol"
	adapter.mu.Unlock()

	snapshot, ok := adapter.snapshotExecState(session.AgentSessionID)
	if !ok {
		t.Fatal("snapshotExecState = false, want live session")
	}

	adapter.mu.Lock()
	appSession.models[0]["model"] = "changed-model"
	efforts, _ := appSession.models[0]["supportedReasoningEfforts"].([]any)
	efforts[0] = "changed-effort"
	appSession.configOptions["model"] = "changed-model"
	nested, _ := appSession.configOptions["nested"].(map[string]any)
	nested["value"] = "changed"
	appSession.defaultModel = "changed-model"
	adapter.mu.Unlock()

	if got := asString(snapshot.models[0]["model"]); got != "gpt-5.6-sol" {
		t.Fatalf("snapshot model = %q, want gpt-5.6-sol", got)
	}
	snapshotEfforts, _ := snapshot.models[0]["supportedReasoningEfforts"].([]any)
	if got := asString(snapshotEfforts[0]); got != "high" {
		t.Fatalf("snapshot reasoning effort = %q, want high", got)
	}
	if got := asString(snapshot.config["model"]); got != "gpt-5.6-sol" {
		t.Fatalf("snapshot config model = %q, want gpt-5.6-sol", got)
	}
	snapshotNested, _ := snapshot.config["nested"].(map[string]any)
	if got := asString(snapshotNested["value"]); got != "original" {
		t.Fatalf("snapshot nested config = %q, want original", got)
	}
	if snapshot.defaultModel != "gpt-5.6-sol" {
		t.Fatalf("snapshot default model = %q, want gpt-5.6-sol", snapshot.defaultModel)
	}
}

func TestCodexAppServerAdapterExecStateSnapshotConcurrentSettingsUpdates(t *testing.T) {
	t.Parallel()

	adapter, _, session := startedAppServerAdapter(t)
	const iterations = 500
	start := make(chan struct{})
	errCh := make(chan error, 1)
	report := func(err error) {
		select {
		case errCh <- err:
		default:
		}
	}

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		<-start
		for i := range iterations {
			model := "gpt-5.1-codex"
			effort := "high"
			speed := "standard"
			if i%2 == 1 {
				model = "gpt-5.1-codex-mini"
				effort = "low"
				speed = "fast"
			}
			updated := session
			updated.Settings = &SessionSettings{Model: model, ReasoningEffort: effort, Speed: speed}
			if err := adapter.ApplySessionSettings(context.Background(), updated, SessionSettingsPatch{
				Model:           &model,
				ReasoningEffort: &effort,
				Speed:           &speed,
			}); err != nil {
				report(fmt.Errorf("ApplySessionSettings: %w", err))
				return
			}
		}
	}()
	go func() {
		defer wg.Done()
		<-start
		for range iterations {
			snapshot, ok := adapter.snapshotExecState(session.AgentSessionID)
			if !ok {
				report(errors.New("snapshotExecState lost live session"))
				return
			}
			for _, model := range snapshot.models {
				_ = fmt.Sprint(model)
			}
			_ = fmt.Sprint(snapshot.config)
			_ = snapshot.defaultModel
		}
	}()
	close(start)
	wg.Wait()
	select {
	case err := <-errCh:
		t.Fatal(err)
	default:
	}
}

func TestCodexAppServerAdapterLateModelListPreservesUpdatedSettings(t *testing.T) {
	t.Parallel()

	adapter, _, session := startedAppServerAdapter(t)
	adapter.mu.Lock()
	adapter.sessions[session.AgentSessionID].models = nil
	adapter.mu.Unlock()
	model := "gpt-5.6-luna"
	effort := "high"
	updatedSession := session
	updatedSession.Settings = &SessionSettings{Model: model, ReasoningEffort: effort}
	if err := adapter.ApplySessionSettings(context.Background(), updatedSession, SessionSettingsPatch{
		Model:           &model,
		ReasoningEffort: &effort,
	}); err != nil {
		t.Fatalf("ApplySessionSettings: %v", err)
	}

	startupSession := session
	startupSession.Settings = &SessionSettings{Model: "gpt-5.6-sol", ReasoningEffort: "ultra"}
	if applied := adapter.applyStartupModels(session.AgentSessionID, startupSession, nil, []map[string]any{
		{
			"id":                        "gpt-5.6-sol",
			"defaultReasoningEffort":    "high",
			"supportedReasoningEfforts": []any{"low", "medium", "high", "xhigh", "max", "ultra"},
		},
		{
			"id":                        "gpt-5.6-luna",
			"defaultReasoningEffort":    "high",
			"supportedReasoningEfforts": []any{"low", "medium", "high", "xhigh", "max"},
		},
	}); !applied {
		t.Fatal("applyStartupModels = false, want true")
	}

	state := adapter.SessionState(updatedSession)
	config, _ := state.RuntimeContext["config"].(map[string]any)
	if got := asString(config["model"]); got != model {
		t.Fatalf("late model/list model = %q, want %q", got, model)
	}
	if got := asString(config["reasoning_effort"]); got != effort {
		t.Fatalf("late model/list reasoning effort = %q, want %q", got, effort)
	}
}

func TestCodexAppServerAdapterClearedSettingsOverrideStaleLiveConfigBeforeModels(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	adapter.mu.Lock()
	appSession := adapter.sessions[session.AgentSessionID]
	appSession.models = nil
	appSession.configOptions = map[string]any{
		"model":            "gpt-stale",
		"reasoning_effort": "ultra",
	}
	adapter.mu.Unlock()
	empty := ""
	updatedSession := session
	updatedSession.Settings = &SessionSettings{}
	if err := adapter.ApplySessionSettings(context.Background(), updatedSession, SessionSettingsPatch{
		Model:           &empty,
		ReasoningEffort: &empty,
	}); err != nil {
		t.Fatalf("ApplySessionSettings: %v", err)
	}
	state := adapter.SessionState(updatedSession)
	if state.Settings == nil || state.Settings.Model != "" || state.Settings.ReasoningEffort != "" {
		t.Fatalf("cleared live settings = %#v, want empty model and reasoning", state.Settings)
	}

	if _, err := adapter.Exec(context.Background(), updatedSession, []PromptContentBlock{{
		Type: "text", Text: "go",
	}}, "", "turn-clear-before-models", nil, nil); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	turnStart := appServerRequestParams(t, transport.conn, appServerMethodTurnStart)
	if got := asString(turnStart["model"]); got == "gpt-stale" {
		t.Fatalf("turn/start model = %q, stale explicit model was restored", got)
	}
	if got := asString(turnStart["effort"]); got != "" {
		t.Fatalf("turn/start effort = %q, want cleared", got)
	}
}

func TestCodexAppServerAdapterModelWithoutReasoningClearsEffectiveState(t *testing.T) {
	t.Parallel()

	adapter, _, session := startedAppServerAdapter(t)
	adapter.mu.Lock()
	adapter.sessions[session.AgentSessionID].models = []map[string]any{
		{
			"model":                     "gpt-reasoning",
			"defaultReasoningEffort":    "high",
			"supportedReasoningEfforts": []any{"low", "high"},
		},
		{
			"model":                     "gpt-no-reasoning",
			"supportedReasoningEfforts": []any{},
		},
	}
	adapter.mu.Unlock()
	updatedSession := session
	updatedSession.Settings = &SessionSettings{Model: "gpt-no-reasoning", ReasoningEffort: "high"}
	model := "gpt-no-reasoning"
	if err := adapter.ApplySessionSettings(context.Background(), updatedSession, SessionSettingsPatch{
		Model: &model,
	}); err != nil {
		t.Fatalf("ApplySessionSettings: %v", err)
	}

	state := adapter.SessionState(updatedSession)
	if state.Settings == nil || state.Settings.Model != model || state.Settings.ReasoningEffort != "" {
		t.Fatalf("effective settings = %#v, want no-reasoning model with empty effort", state.Settings)
	}
	options, _ := state.RuntimeContext["configOptions"].([]map[string]any)
	reasoning := configOptionByID(options, "reasoning_effort")
	if reasoning == nil || len(configOptionValues(reasoning)) != 0 || reasoning["currentValue"] != nil {
		t.Fatalf("reasoning option = %#v, want explicit empty live profile", reasoning)
	}
}

func TestCodexAppServerAdapterLateModelListHonorsClearedSettings(t *testing.T) {
	t.Parallel()

	adapter, _, session := startedAppServerAdapter(t)
	adapter.mu.Lock()
	appSession := adapter.sessions[session.AgentSessionID]
	appSession.models = nil
	appSession.configOptions = map[string]any{
		"model":            "gpt-stale",
		"reasoning_effort": "ultra",
	}
	adapter.mu.Unlock()
	empty := ""
	updatedSession := session
	updatedSession.Settings = &SessionSettings{}
	if err := adapter.ApplySessionSettings(context.Background(), updatedSession, SessionSettingsPatch{
		Model:           &empty,
		ReasoningEffort: &empty,
	}); err != nil {
		t.Fatalf("ApplySessionSettings: %v", err)
	}

	startupSession := session
	startupSession.Settings = &SessionSettings{Model: "gpt-stale", ReasoningEffort: "ultra"}
	if applied := adapter.applyStartupModels(session.AgentSessionID, startupSession, nil, []map[string]any{
		{
			"model":                     "gpt-default",
			"isDefault":                 true,
			"defaultReasoningEffort":    "medium",
			"supportedReasoningEfforts": []any{"low", "medium", "high"},
		},
		{
			"model":                     "gpt-stale",
			"defaultReasoningEffort":    "high",
			"supportedReasoningEfforts": []any{"high", "ultra"},
		},
	}); !applied {
		t.Fatal("applyStartupModels = false, want true")
	}

	state := adapter.SessionState(updatedSession)
	config, _ := state.RuntimeContext["config"].(map[string]any)
	if got := asString(config["model"]); got != "gpt-default" {
		t.Fatalf("late model/list model = %q, want provider default", got)
	}
	if got := asString(config["reasoning_effort"]); got != "medium" {
		t.Fatalf("late model/list reasoning = %q, want provider default", got)
	}
}

func TestCodexAppServerAdapterLateModelListClampsProviderDefaultReasoning(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	adapter.mu.Lock()
	appSession := adapter.sessions[session.AgentSessionID]
	appSession.models = nil
	appSession.configOptions = map[string]any{"reasoning_effort": "ultra"}
	adapter.mu.Unlock()
	session.Settings = &SessionSettings{ReasoningEffort: "ultra"}
	models := []map[string]any{{
		"id":                        "gpt-default",
		"isDefault":                 true,
		"defaultReasoningEffort":    "high",
		"supportedReasoningEfforts": []any{"low", "medium", "high"},
	}}

	if applied := adapter.applyStartupModels(session.AgentSessionID, session, nil, models); !applied {
		t.Fatal("applyStartupModels = false, want true")
	}
	state := adapter.SessionState(session)
	config, _ := state.RuntimeContext["config"].(map[string]any)
	if got := asString(config["model"]); got != "gpt-default" {
		t.Fatalf("late model/list model = %q, want gpt-default", got)
	}
	if got := asString(config["reasoning_effort"]); got != "high" {
		t.Fatalf("late model/list reasoning effort = %q, want high", got)
	}
	if state.Settings == nil || state.Settings.Model != "gpt-default" || state.Settings.ReasoningEffort != "high" {
		t.Fatalf("late model/list settings = %#v, want gpt-default/high", state.Settings)
	}

	if _, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "go",
	}}, "", "turn-default-model", nil, nil); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	turnStart := appServerRequestParams(t, transport.conn, appServerMethodTurnStart)
	if got := asString(turnStart["model"]); got != "gpt-default" {
		t.Fatalf("turn/start model = %q, want gpt-default", got)
	}
	if got := asString(turnStart["effort"]); got != "high" {
		t.Fatalf("turn/start effort = %q, want high", got)
	}
}

func TestCodexAppServerAdapterApplyPermissionModeUpdatesState(t *testing.T) {
	t.Parallel()

	adapter, _, session := startedAppServerAdapter(t)
	session.PermissionModeID = "full-access"
	if err := adapter.ApplyPermissionMode(context.Background(), session); err != nil {
		t.Fatalf("ApplyPermissionMode: %v", err)
	}
	state := adapter.SessionState(session)
	if asString(state.RuntimeContext["mode"]) != "full-access" {
		t.Fatalf("mode = %#v, want full-access", state.RuntimeContext["mode"])
	}
}

// TestCodexAppServerAdapterApplyPermissionModeSucceedsMidTurnAndAppliesNextTurn
// locks in the contract the composer UI's live permission-mode switch now
// relies on: the app-server protocol has no RPC to change approval/sandbox
// policy for a turn that's already running, so ApplyPermissionMode must still
// succeed while a turn is in flight (rather than error or block), and the
// new policy must only take effect starting with the *next* turn/start --
// matching the "applies starting with your next message" copy shown to the
// user when they change permission mode mid-turn.
func TestCodexAppServerAdapterApplyPermissionModeSucceedsMidTurnAndAppliesNextTurn(t *testing.T) {
	t.Parallel()

	transport := newScriptedAppServerTransport()
	adapter := NewCodexAppServerAdapterWithHostMetadataAndOptions(
		transport,
		LegacyHostMetadata(),
		CodexAppServerAdapterOptions{CommandNetworkAccess: true},
	)
	session := testAppServerSession()
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	session.ProviderSessionID = "codex-thread-1"
	session.PermissionModeID = "read-only"
	transport.server.holdTurn = true

	execDone := make(chan struct{})
	go func() {
		_, _ = adapter.Exec(context.Background(), session, []PromptContentBlock{{
			Type: "text", Text: "go",
		}}, "", "turn-local-1", nil, nil)
		close(execDone)
	}()
	waitForCondition(t, func() bool {
		return adapter.sessionActiveTurnID(session.AgentSessionID) == "turn-1"
	})

	firstTurnStart := appServerRequestParams(t, transport.conn, appServerMethodTurnStart)
	if asString(firstTurnStart["approvalPolicy"]) != "on-request" {
		t.Fatalf("first turn/start approvalPolicy = %#v, want on-request", firstTurnStart["approvalPolicy"])
	}
	firstPolicy, _ := firstTurnStart["sandboxPolicy"].(map[string]any)
	if asString(firstPolicy["type"]) != "readOnly" {
		t.Fatalf("first turn/start sandboxPolicy = %#v, want readOnly", firstPolicy)
	}
	if enabled, _ := firstPolicy["networkAccess"].(bool); !enabled {
		t.Fatalf("first turn/start sandboxPolicy = %#v, want networkAccess=true", firstPolicy)
	}

	session.PermissionModeID = "full-access"
	if err := adapter.ApplyPermissionMode(context.Background(), session); err != nil {
		t.Fatalf("ApplyPermissionMode mid-turn: %v", err)
	}

	transport.server.completePendingTurn()
	<-execDone

	// The turn that was already running is unaffected by the change: exactly
	// one turn/start was sent for it.
	if turnStarts := appServerRequestParamsList(t, transport.conn, appServerMethodTurnStart); len(turnStarts) != 1 {
		t.Fatalf("turn/start calls = %d, want 1 before the next turn", len(turnStarts))
	}

	transport.server.holdTurn = false
	if _, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "go again",
	}}, "", "turn-local-2", nil, nil); err != nil {
		t.Fatalf("Exec (second turn): %v", err)
	}

	turnStarts := appServerRequestParamsList(t, transport.conn, appServerMethodTurnStart)
	if len(turnStarts) != 2 {
		t.Fatalf("turn/start calls = %d, want 2 after the next turn", len(turnStarts))
	}
	if asString(turnStarts[1]["approvalPolicy"]) != "never" {
		t.Fatalf("second turn/start approvalPolicy = %#v, want never", turnStarts[1]["approvalPolicy"])
	}
	secondPolicy, _ := turnStarts[1]["sandboxPolicy"].(map[string]any)
	if asString(secondPolicy["type"]) != "dangerFullAccess" {
		t.Fatalf("second turn/start sandboxPolicy = %#v, want dangerFullAccess", secondPolicy)
	}
	if _, ok := secondPolicy["networkAccess"]; ok {
		t.Fatalf("second turn/start sandboxPolicy = %#v, want implicit full-access networking", secondPolicy)
	}
}
