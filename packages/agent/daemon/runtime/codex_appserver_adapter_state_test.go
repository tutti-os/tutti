package agentruntime

import (
	"context"
	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestCodexAppServerAdapterSessionStateIncludesModelsAccountAndRateLimits(t *testing.T) {
	t.Parallel()

	adapter, _, session := startedAppServerAdapter(t)
	state := adapter.SessionState(session)

	options, _ := state.RuntimeContext["configOptions"].([]map[string]any)
	var modelOption map[string]any
	var effortOption map[string]any
	for _, option := range options {
		switch asString(option["id"]) {
		case "model":
			modelOption = option
		case "reasoning_effort":
			effortOption = option
		}
	}
	if modelOption == nil {
		t.Fatalf("missing model config option: %#v", options)
	}
	if asString(modelOption["currentValue"]) != "gpt-5.1-codex" {
		t.Fatalf("model currentValue = %#v", modelOption)
	}
	values, _ := modelOption["options"].([]any)
	if len(values) != 1 {
		t.Fatalf("model options = %#v, want hidden models excluded", values)
	}
	if effortOption == nil || asString(effortOption["currentValue"]) != "medium" {
		t.Fatalf("effort option = %#v", effortOption)
	}

	account, _ := state.RuntimeContext["account"].(map[string]any)
	if asString(account["email"]) != "dev@example.com" || asString(account["planType"]) != "pro" {
		t.Fatalf("account = %#v", account)
	}
	capabilities, _ := state.RuntimeContext["capabilities"].([]string)
	if !containsString(capabilities, CapabilityActiveTurnGuidance) || !containsString(capabilities, CapabilityRateLimits) {
		t.Fatalf("capabilities = %#v", capabilities)
	}
	commands, _ := state.RuntimeContext["commands"].([]string)
	if !containsString(commands, "review") || !containsString(commands, "compact") || !containsString(commands, "undo") || !containsString(commands, "goal") {
		t.Fatalf("commands = %#v", commands)
	}
	startup, _ := state.RuntimeContext["appServerStartup"].(map[string]any)
	if asString(startup["models"]) != "ready" || asString(startup["rateLimits"]) != "loading" {
		t.Fatalf("appServerStartup = %#v", startup)
	}
}

func TestCodexAppServerAdapterStartSkipsSlowStartupProbesWhenReasoningNeedsNoValidation(t *testing.T) {
	t.Parallel()

	transport := newScriptedAppServerTransport()
	adapter := NewCodexAppServerAdapter(transport)
	session := testAppServerSession()
	session.Settings = &SessionSettings{Model: "gpt-5.3-codex-spark"}
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if requests := appServerRequestParamsList(t, transport.conn, appServerMethodModelList); len(requests) != 0 {
		t.Fatalf("model/list requests = %d, want 0 on startup with explicit model", len(requests))
	}
	if requests := appServerRequestParamsList(t, transport.conn, appServerMethodRateLimitsRead); len(requests) != 0 {
		t.Fatalf("rateLimits/read requests = %d, want 0 on startup", len(requests))
	}
	state := adapter.SessionState(session)
	options, _ := state.RuntimeContext["configOptions"].([]map[string]any)
	modelOption := configOptionByID(options, "model")
	if modelOption == nil {
		t.Fatalf("missing minimal model config option: %#v", options)
	}
	if asString(modelOption["currentValue"]) != "gpt-5.3-codex-spark" {
		t.Fatalf("model option = %#v, want explicit current model", modelOption)
	}
	values := configOptionValues(modelOption)
	if !containsString(values, "gpt-5.3-codex-spark") {
		t.Fatalf("model option values = %#v, want explicit model", values)
	}
	startup, _ := state.RuntimeContext["appServerStartup"].(map[string]any)
	if asString(startup["models"]) != "loading" || asString(startup["rateLimits"]) != "loading" {
		t.Fatalf("appServerStartup = %#v, want startup probes loading", startup)
	}
}

func TestCodexAppServerAdapterRefreshesStartupMetadataAsync(t *testing.T) {
	t.Parallel()

	transport := newScriptedAppServerTransport()
	controller := NewDefaultControllerWithProcessTransport(nil, transport)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		CWD:            "/workspace/room-1",
		Settings: &SessionSettings{
			Model:           "gpt-5.3-codex-spark",
			ReasoningEffort: "high",
		},
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	waitForCondition(t, func() bool {
		state, err := controller.State("room-1", started.Session.AgentSessionID)
		if err != nil {
			return false
		}
		rateLimits, _ := state.RuntimeContext["rateLimits"].(map[string]any)
		if rateLimits == nil {
			return false
		}
		startup, _ := state.RuntimeContext["appServerStartup"].(map[string]any)
		if asString(startup["models"]) != "ready" || asString(startup["rateLimits"]) != "ready" {
			return false
		}
		options, _ := state.RuntimeContext["configOptions"].([]map[string]any)
		modelOption := configOptionByID(options, "model")
		values := configOptionValues(modelOption)
		return containsString(values, "gpt-5.1-codex") &&
			containsString(values, "gpt-5.3-codex-spark")
	})
}

func configOptionByID(options []map[string]any, id string) map[string]any {
	for _, option := range options {
		if asString(option["id"]) == id {
			return option
		}
	}
	return nil
}

func configOptionValues(option map[string]any) []string {
	if len(option) == 0 {
		return nil
	}
	raw, _ := option["options"].([]any)
	values := make([]string, 0, len(raw))
	for _, entry := range raw {
		entryMap, _ := entry.(map[string]any)
		if value := asString(entryMap["value"]); value != "" {
			values = append(values, value)
		}
	}
	return values
}

func TestCodexAppServerAdapterSessionCommandSnapshot(t *testing.T) {
	t.Parallel()

	adapter, _, session := startedAppServerAdapter(t)
	snapshot, ok := adapter.SessionCommandSnapshot(session)
	if !ok {
		t.Fatalf("SessionCommandSnapshot not available")
	}
	names := agentSessionCommandNames(snapshot.Commands)
	for _, want := range []string{"review", "compact", "undo", "goal"} {
		if !containsString(names, want) {
			t.Fatalf("commands = %#v, want %q", names, want)
		}
	}
}

func TestCodexAppServerAdapterRateLimitNotificationUpdatesUsage(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.conn.notify(appServerNotifyRateLimitsUpdated, map[string]any{
		"rateLimits": map[string]any{
			"primary":   map[string]any{"usedPercent": 40, "resetsAt": 1750003600},
			"secondary": map[string]any{"usedPercent": 5},
		},
	})
	waitForCondition(t, func() bool {
		state := adapter.SessionState(session)
		usage, _ := state.RuntimeContext["usage"].(map[string]any)
		quotas, _ := usage["quotas"].([]map[string]any)
		for _, quota := range quotas {
			if asString(quota["quotaType"]) != "session" {
				continue
			}
			remaining, _ := acpFloatValue(quota["percentRemaining"])
			return remaining == 60
		}
		return false
	})
	state := adapter.SessionState(session)
	usage, _ := state.RuntimeContext["usage"].(map[string]any)
	quotas, _ := usage["quotas"].([]map[string]any)
	var sessionQuota map[string]any
	for _, quota := range quotas {
		if asString(quota["quotaType"]) == "session" {
			sessionQuota = quota
		}
	}
	if sessionQuota == nil {
		t.Fatalf("quotas = %#v, want session quota", quotas)
	}
	if remaining, _ := acpFloatValue(sessionQuota["percentRemaining"]); remaining != 60 {
		t.Fatalf("session quota = %#v, want 60%% remaining", sessionQuota)
	}
	if resetsAt, _ := int64Value(sessionQuota["resetsAtUnixMs"]); resetsAt != 1750003600000 {
		t.Fatalf("session quota resetsAt = %#v", sessionQuota)
	}
}

func TestCodexAppServerAdapterClassifiesPrimaryWeeklyRateLimitFromDuration(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.conn.notify(appServerNotifyRateLimitsUpdated, map[string]any{
		"rateLimits": map[string]any{
			"primary": map[string]any{
				"resetsAt":           1784604546,
				"usedPercent":        14,
				"windowDurationMins": 7 * 24 * 60,
			},
			"secondary": nil,
		},
	})
	waitForCondition(t, func() bool {
		state := adapter.SessionState(session)
		usage, _ := state.RuntimeContext["usage"].(map[string]any)
		quotas, _ := usage["quotas"].([]map[string]any)
		if len(quotas) != 1 || asString(quotas[0]["quotaType"]) != "weekly" {
			return false
		}
		remaining, _ := acpFloatValue(quotas[0]["percentRemaining"])
		return remaining == 86
	})
	state := adapter.SessionState(session)
	usage, _ := state.RuntimeContext["usage"].(map[string]any)
	quotas, _ := usage["quotas"].([]map[string]any)
	if len(quotas) != 1 {
		t.Fatalf("quotas = %#v, want one weekly quota", quotas)
	}
	if resetsAt, _ := int64Value(quotas[0]["resetsAtUnixMs"]); resetsAt != 1784604546000 {
		t.Fatalf("weekly quota resetsAt = %#v", quotas[0])
	}
}

func TestCodexAppServerAdapterCloseShutsDownSession(t *testing.T) {
	t.Parallel()

	adapter, _, session := startedAppServerAdapter(t)
	if err := adapter.Close(context.Background(), session); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if adapter.getSession(session.AgentSessionID) != nil {
		t.Fatalf("session should be removed after Close")
	}
	if _, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "go",
	}}, "", "turn-local-1", nil, nil); err == nil {
		t.Fatalf("Exec after Close should fail with disconnected session")
	}
}

func TestCodexAppServerAdapterWarningNotificationsBecomeSystemNotices(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.server.holdTurn = true

	var streamed []activityshared.Event
	var streamedMu sync.Mutex
	execDone := make(chan struct{})
	go func() {
		_, _ = adapter.Exec(context.Background(), session, []PromptContentBlock{{
			Type: "text", Text: "go",
		}}, "", "turn-local-1", func(next []activityshared.Event) {
			streamedMu.Lock()
			streamed = append(streamed, next...)
			streamedMu.Unlock()
		}, nil)
		close(execDone)
	}()
	waitForCondition(t, func() bool {
		return adapter.sessionActiveTurnID(session.AgentSessionID) == "turn-1"
	})

	transport.conn.notify(appServerNotifyWarning, map[string]any{
		"message":  "Model fell back to a smaller context window.",
		"threadId": "codex-thread-1",
	})
	transport.conn.notify(appServerNotifyError, map[string]any{
		"threadId":  "codex-thread-1",
		"turnId":    "turn-1",
		"willRetry": true,
		"error":     map[string]any{"message": "stream disconnected"},
	})
	waitForCondition(t, func() bool {
		streamedMu.Lock()
		defer streamedMu.Unlock()
		notices := 0
		for _, event := range streamed {
			if event.Type == activityshared.EventMessageAppended &&
				asString(event.Payload.Metadata["kind"]) == "agent_system_notice" {
				notices++
			}
		}
		return notices >= 2
	})

	streamedMu.Lock()
	var retryNotice map[string]any
	for _, event := range streamed {
		if asString(event.Payload.Metadata["noticeKind"]) == "transport_retry" {
			retryNotice = event.Payload.Metadata
		}
	}
	streamedMu.Unlock()
	if retryNotice == nil {
		t.Fatalf("missing transport retry notice")
	}

	transport.server.completePendingTurn()
	<-execDone
}

func TestCodexAppServerAdapterTerminalErrorNotificationFailsTurn(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.server.holdTurn = true

	var events []activityshared.Event
	var execErr error
	execDone := make(chan struct{})
	go func() {
		events, execErr = adapter.Exec(context.Background(), session, []PromptContentBlock{{
			Type: "text", Text: "go",
		}}, "", "turn-local-1", nil, nil)
		close(execDone)
	}()
	waitForCondition(t, func() bool {
		return adapter.sessionActiveTurnID(session.AgentSessionID) == "turn-1"
	})

	transport.conn.notify(appServerNotifyError, map[string]any{
		"threadId":  "codex-thread-1",
		"turnId":    "turn-1",
		"willRetry": false,
		"error":     map[string]any{"message": "model overloaded"},
	})

	select {
	case <-execDone:
	case <-time.After(2 * time.Second):
		t.Fatal("Exec did not unblock after terminal error notification")
	}
	if execErr != nil {
		t.Fatalf("Exec: %v", execErr)
	}
	failed := eventsOfType(events, activityshared.EventRootProviderTurnCompleted)
	if len(failed) != 1 || failed[0].Payload.TurnOutcome != string(activityshared.TurnOutcomeFailed) {
		t.Fatalf("root provider failed events = %#v, want one failed outcome; events = %#v", failed, events)
	}
	if got := asString(failed[0].Payload.Metadata["error"]); got != "model overloaded" {
		t.Fatalf("turn failure error = %q, want model overloaded", got)
	}
}

func TestCodexAppServerAdapterDefaultControllerUsesAppServerForCodex(t *testing.T) {
	t.Parallel()

	controller := NewDefaultControllerWithProcessTransport(nil, newScriptedAppServerTransport())
	adapter := controller.adapter(ProviderCodex)
	if _, ok := adapter.(*CodexAppServerAdapter); !ok {
		t.Fatalf("codex adapter = %T, want *CodexAppServerAdapter", adapter)
	}
	if nexight := controller.adapter(ProviderNexight); nexight == nil {
		t.Fatalf("nexight adapter missing")
	} else if _, ok := nexight.(*standardACPAdapter); !ok {
		t.Fatalf("nexight adapter = %T, want standard ACP adapter", nexight)
	}
}

func TestCodexAppServerAdapterReportsPlanModeCapabilityWhenCollaborationModesAvailable(t *testing.T) {
	t.Parallel()

	adapter, _, session := startedAppServerAdapter(t)
	state := adapter.SessionState(session)
	capabilities, _ := state.RuntimeContext["capabilities"].([]string)
	if !containsString(capabilities, CapabilityPlanMode) {
		t.Fatalf("capabilities = %#v, want planMode", capabilities)
	}
}

func TestCodexAppServerAdapterOmitsPlanModeCapabilityWithoutCollaborationModes(t *testing.T) {
	t.Parallel()

	transport := newScriptedAppServerTransport()
	transport.server.collaborationModeUnsupported = true
	adapter := NewCodexAppServerAdapter(transport)
	session := testAppServerSession()
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	session.ProviderSessionID = "codex-thread-1"
	state := adapter.SessionState(session)
	capabilities, _ := state.RuntimeContext["capabilities"].([]string)
	if containsString(capabilities, CapabilityPlanMode) {
		t.Fatalf("capabilities = %#v, want no planMode without collaboration modes", capabilities)
	}
}

func TestCodexAppServerAdapterSendsCollaborationModeForPlanTurns(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	session.Settings = &SessionSettings{PlanMode: true}
	if _, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "plan it",
	}}, "", "turn-plan-1", nil, nil); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	turnStart := appServerRequestParams(t, transport.conn, appServerMethodTurnStart)
	collaborationMode, _ := turnStart["collaborationMode"].(map[string]any)
	if asString(collaborationMode["mode"]) != "plan" {
		t.Fatalf("turn/start collaborationMode = %#v, want plan preset", turnStart["collaborationMode"])
	}
	settings, _ := collaborationMode["settings"].(map[string]any)
	// Settings.model is a required String in the app-server schema; the
	// adapter fills it from the session default when no override is set.
	if asString(settings["model"]) != "gpt-5.1-codex" {
		t.Fatalf("collaborationMode settings = %#v, want default model", settings)
	}
	if asString(settings["reasoning_effort"]) != "medium" {
		t.Fatalf("collaborationMode settings = %#v, want preset reasoning effort", settings)
	}
	if value := asString(settings["developer_instructions"]); value != testAppServerPlanCollaborationInstructions {
		t.Fatalf("collaborationMode settings = %#v, want plan developer_instructions", settings)
	}

	defaultAdapter, defaultTransport, defaultSession := startedAppServerAdapter(t)
	defaultSession.Settings = &SessionSettings{PlanMode: false}
	if _, err := defaultAdapter.Exec(context.Background(), defaultSession, []PromptContentBlock{{
		Type: "text", Text: "now build",
	}}, "", "turn-plan-2", nil, nil); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	defaultTurnStart := appServerRequestParams(t, defaultTransport.conn, appServerMethodTurnStart)
	exitMode, _ := defaultTurnStart["collaborationMode"].(map[string]any)
	if asString(exitMode["mode"]) != "default" {
		t.Fatalf("turn/start collaborationMode = %#v, want explicit default mode", defaultTurnStart["collaborationMode"])
	}
	exitSettings, _ := exitMode["settings"].(map[string]any)
	if asString(exitSettings["model"]) != "gpt-5.1-codex" {
		t.Fatalf("default collaborationMode settings = %#v, want default model", exitSettings)
	}
	if value := asString(exitSettings["developer_instructions"]); value != testAppServerDefaultCollaborationInstructions {
		t.Fatalf("default collaborationMode settings = %#v, want default developer_instructions", exitSettings)
	}

	overrideAdapter, overrideTransport, overrideSession := startedAppServerAdapter(t)
	overrideSession.Settings = &SessionSettings{PlanMode: true, Model: "gpt-5.1-codex-mini", ReasoningEffort: "low"}
	if _, err := overrideAdapter.Exec(context.Background(), overrideSession, []PromptContentBlock{{
		Type: "text", Text: "plan again",
	}}, "", "turn-plan-3", nil, nil); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	overrideTurnStart := appServerRequestParams(t, overrideTransport.conn, appServerMethodTurnStart)
	overrideMode, _ := overrideTurnStart["collaborationMode"].(map[string]any)
	overrideSettings, _ := overrideMode["settings"].(map[string]any)
	if asString(overrideSettings["model"]) != "gpt-5.1-codex-mini" || asString(overrideSettings["reasoning_effort"]) != "low" {
		t.Fatalf("collaborationMode settings = %#v, want session overrides", overrideSettings)
	}
	if value := asString(overrideSettings["developer_instructions"]); value != testAppServerPlanCollaborationInstructions {
		t.Fatalf("plan collaborationMode settings = %#v, want plan developer_instructions", overrideSettings)
	}
}

func TestCodexAppServerAdapterDoesNotSendConversationDetailModeInstructionsPerTurn(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	session.Settings = &SessionSettings{ConversationDetailMode: AgentConversationDetailModeGeneral}
	if _, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "summarize this",
	}}, "", "turn-general-1", nil, nil); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	turnStart := appServerRequestParams(t, transport.conn, appServerMethodTurnStart)
	collaborationMode, _ := turnStart["collaborationMode"].(map[string]any)
	if asString(collaborationMode["mode"]) != "default" {
		t.Fatalf("turn/start collaborationMode = %#v, want default mode", turnStart["collaborationMode"])
	}
	settings, _ := collaborationMode["settings"].(map[string]any)
	if value := asString(settings["developer_instructions"]); value != testAppServerDefaultCollaborationInstructions {
		t.Fatalf("collaborationMode settings = %#v, want default collaboration mode developer_instructions", settings)
	}
}

func TestCodexAppServerAdapterEmitsPlanItemAsTaggedMessage(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.server.mu.Lock()
	transport.server.emitPlanItem = true
	transport.server.mu.Unlock()
	session.Settings = &SessionSettings{PlanMode: true}
	adapterTurnEvents, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "plan it",
	}}, "", "turn-plan-track-1", nil, nil)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	planMessages := 0
	for _, event := range eventsOfType(adapterTurnEvents, activityshared.EventMessageAppended) {
		if event.Payload.Metadata["messageKind"] == "plan" {
			planMessages++
			if !strings.Contains(event.Payload.Content, "# Plan") {
				t.Fatalf("plan message content = %q, want plan text", event.Payload.Content)
			}
		}
	}
	if planMessages != 1 {
		t.Fatalf("plan-tagged messages = %d, want exactly 1", planMessages)
	}
}
