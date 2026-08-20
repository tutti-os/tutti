package agent

import (
	"context"
	"errors"
	"testing"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	runtimeprep "github.com/tutti-os/tutti/packages/agent/runtimeprep"
	agentactivitybiz "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	reporterservice "github.com/tutti-os/tutti/services/tuttid/service/reporter"
)

func TestServiceSendInputContinuesImportedSession(t *testing.T) {
	// Imported conversations must continue in place: sending resumes (or, when
	// the provider session is missing locally, recreates) the provider session
	// rather than rejecting with ErrSessionNotFound and forcing a new chat.
	runtime := newFakeRuntime()
	service := newIsolatedAgentService(runtime)
	service.SessionReader = fakeSessionReader{
		sessions: map[string]PersistedSession{
			"ws-1:session-imported": {
				ID:                "session-imported",
				WorkspaceID:       "ws-1",
				Provider:          "codex",
				ProviderSessionID: "imported-thread-1",
				Origin:            WorkspaceAgentSessionOriginImported,
				Title:             "Imported chat",
				CreatedAtUnixMS:   1000,
				UpdatedAtUnixMS:   2000,
			},
		},
	}

	if _, err := service.SendInput(context.Background(), "ws-1", "session-imported", SendInput{Content: TextPromptContent("continue")}); err != nil {
		t.Fatalf("SendInput imported error = %v, want continue in place", err)
	}
	if len(runtime.resumeCalls) != 1 {
		t.Fatalf("resume calls = %d, want 1", len(runtime.resumeCalls))
	}
	if len(runtime.execCalls) != 1 {
		t.Fatalf("exec calls = %d, want 1", len(runtime.execCalls))
	}
}

func TestServiceSendInputReturnsRuntimeExecStatusOverStalePersistedStatus(t *testing.T) {
	runtime := newFakeRuntime()
	service := newIsolatedAgentService(runtime)
	exactTurn := agentactivitybiz.Turn{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: "turn-1",
		Phase: agentactivitybiz.TurnPhaseSubmitted, Origin: agentactivitybiz.TurnOriginUserPrompt,
		StartedAtUnixMS: 3000, UpdatedAtUnixMS: 3000,
	}
	service.TurnStore = failingTurnStore{
		session: agentactivitybiz.Session{WorkspaceID: "ws-1", ID: "session-1", ActiveTurnID: "turn-1"},
		turn:    exactTurn, latestTurn: exactTurn,
	}
	service.SessionReader = fakeSessionReader{
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:                "session-1",
				WorkspaceID:       "ws-1",
				Provider:          "codex",
				ProviderSessionID: "provider-session-1",
				Title:             "Persisted session",
				CreatedAtUnixMS:   1000,
				UpdatedAtUnixMS:   2000,
			},
		},
	}

	result, err := service.SendInput(context.Background(), "ws-1", "session-1", SendInput{
		TurnID: "turn-1", Content: TextPromptContent("hello"),
	})
	if err != nil {
		t.Fatalf("SendInput returned error: %v", err)
	}
	if result.Session.EndedAt != nil {
		t.Fatalf("endedAt = %#v, want nil for accepted input", result.Session.EndedAt)
	}
	if result.Turn == nil || result.Turn.TurnID != "turn-1" || result.Turn.Phase != agentactivitybiz.TurnPhaseSubmitted {
		t.Fatalf("turn = %#v, want exact durable submitted turn", result.Turn)
	}
}

func TestServiceSendInputReportsNodeResults(t *testing.T) {
	runtime := newFakeRuntime()
	reporter := &recordingAgentAnalyticsReporter{}
	service := newIsolatedAgentService(runtime)
	service.AnalyticsReporter = reporter
	service.SessionReader = fakeSessionReader{
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:                "session-1",
				WorkspaceID:       "ws-1",
				Provider:          "codex",
				ProviderSessionID: "provider-session-1",
				ActiveTurnID:      "turn-1",
				Title:             "Persisted session",
				CreatedAtUnixMS:   1000,
				UpdatedAtUnixMS:   2000,
			},
		},
	}

	if _, err := service.SendInput(context.Background(), "ws-1", "session-1", SendInput{Content: TextPromptContent("hello")}); err != nil {
		t.Fatalf("SendInput returned error: %v", err)
	}

	assertAgentNodeSequence(t, reporter.events, []string{
		"content_normalized",
		"runtime_session_ready",
		"prompt_validated",
		"prompt_prepared",
		"runtime_exec",
		"session_refreshed",
	})
	for _, event := range reporter.events {
		if event.Name != "agent.node_result" {
			continue
		}
		if got := event.Params["flow"]; got != "message_send" {
			t.Fatalf("flow = %#v, want message_send in %#v", got, event.Params)
		}
		if got := event.Params["status"]; got != "success" {
			t.Fatalf("status = %#v, want success in %#v", got, event.Params)
		}
		if got := event.Params["error_code"]; got != "agent_error_none" {
			t.Fatalf("error_code = %#v, want agent_error_none in %#v", got, event.Params)
		}
		if got := event.Params["error_message"]; got != "" {
			t.Fatalf("error_message = %#v, want empty in %#v", got, event.Params)
		}
		if got := event.Params["node_name"]; got != event.Params["node"] {
			t.Fatalf("node_name = %#v, want node alias %#v", got, event.Params["node"])
		}
	}
}

func TestServiceSendInputReportsRuntimeExecFailure(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.execErr = errors.New("network connection disconnected")
	reporter := &recordingAgentAnalyticsReporter{}
	service := newIsolatedAgentService(runtime)
	service.AnalyticsReporter = reporter
	service.SessionReader = fakeSessionReader{
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:                "session-1",
				WorkspaceID:       "ws-1",
				Provider:          "codex",
				ProviderSessionID: "provider-session-1",
				ActiveTurnID:      "turn-1",
				Title:             "Persisted session",
				CreatedAtUnixMS:   1000,
				UpdatedAtUnixMS:   2000,
			},
		},
	}

	if _, err := service.SendInput(context.Background(), "ws-1", "session-1", SendInput{Content: TextPromptContent("hello")}); err == nil {
		t.Fatal("SendInput returned nil error, want runtime exec error")
	}

	var failure reporterservice.Event
	for _, event := range reporter.events {
		if event.Name == "agent.node_result" && event.Params["node"] == "runtime_exec" {
			failure = event
			break
		}
	}
	if failure.Name == "" {
		t.Fatalf("runtime_exec failure event not found in %#v", reporter.events)
	}
	for key, want := range map[string]any{
		"flow":          "message_send",
		"status":        "failure",
		"error_code":    "agent_runtime_network_disconnected",
		"error_message": "network connection disconnected",
		"success":       false,
	} {
		if got := failure.Params[key]; got != want {
			t.Fatalf("params[%q] = %#v, want %#v in %#v", key, got, want, failure.Params)
		}
	}
}

func TestServiceSendInputPersistsPromptAfterRuntimeDispatchError(t *testing.T) {
	runtime := newFakeRuntime()
	providerErr := errors.New("Claude provider rejected the Turn")
	runtime.execHook = func(input RuntimeExecInput) (RuntimeExecResult, error) {
		return RuntimeExecResult{
			AgentSessionID: input.AgentSessionID,
			TurnID:         input.TurnID,
			ProviderDispatch: agenthost.RuntimeProviderDispatchResult{
				Disposition: agenthost.RuntimeDispatchDispositionRejected,
			},
		}, providerErr
	}
	service := newIsolatedAgentService(runtime)
	service.SessionReader = fakeSessionReader{
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID: "session-1", WorkspaceID: "ws-1", Provider: "codex",
				ProviderSessionID: "provider-session-1", CreatedAtUnixMS: 1000,
				UpdatedAtUnixMS: 2000,
			},
		},
	}
	input := SendInput{
		ClientSubmitID: "submit-rejected-1",
		Content:        TextPromptContent("keep this prompt"),
	}
	if _, err := service.SendInput(context.Background(), "ws-1", "session-1", input); !errors.Is(err, providerErr) {
		t.Fatalf("SendInput() error = %v, want provider error", err)
	}
	if len(runtime.provenanceCalls) != 1 {
		t.Fatalf("provenance calls = %d, want 1", len(runtime.provenanceCalls))
	}
	provenance := runtime.provenanceCalls[0]
	if provenance.ClientSubmitID != input.ClientSubmitID || provenance.TurnID == "" ||
		len(provenance.Content) != 1 || provenance.Content[0].Text != "keep this prompt" {
		t.Fatalf("provenance = %#v, want rejected prompt preserved", provenance)
	}
}

func TestServiceDoesNotReconcileStalePersistedTurnWhenRuntimeSessionIsWorking(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{
		ID:                "session-1",
		WorkspaceID:       "ws-1",
		Provider:          "codex",
		ProviderSessionID: "provider-session-1",
		Status:            "working",
	}
	service := newIsolatedAgentService(runtime)
	service.RuntimeOperationStore = &runtimeOperationMemoryStore{}
	service.RuntimeOperationOwner = "worker-a"
	service.TurnStore = runtimeOperationTurnStore("turn-1", "permission-1")
	service.SessionReader = fakeSessionReader{
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:                "session-1",
				WorkspaceID:       "ws-1",
				Provider:          "codex",
				ProviderSessionID: "provider-session-1",
				ActiveTurnID:      "turn-1",
			},
		},
	}

	if _, err := service.SubmitInteractive(
		context.Background(),
		agenthost.InteractionRef{WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: "turn-1", RequestID: "permission-1"},
		agenthost.SubmitInteractiveInput{OptionID: stringRef("approve")},
	); err != nil {
		t.Fatalf("SubmitInteractive returned error: %v", err)
	}
	if len(runtime.submitInteractiveCalls) != 1 {
		t.Fatalf("submit interactive calls = %#v, want live runtime interactive response", runtime.submitInteractiveCalls)
	}
}

func TestServiceGetDoesNotMutateDurableActiveTurn(t *testing.T) {
	runtime := newFakeRuntime()
	service := newIsolatedAgentService(runtime)
	service.SessionReader = fakeSessionReader{
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:                "session-1",
				WorkspaceID:       "ws-1",
				Provider:          "codex",
				ProviderSessionID: "provider-session-1",
				ActiveTurnID:      "turn-1",
			},
		},
	}

	session, err := service.Get(context.Background(), "ws-1", "session-1")
	if err != nil {
		t.Fatalf("Get returned error: %v", err)
	}
	if session.ActiveTurnID != "turn-1" {
		t.Fatalf("active turn id = %q, want durable turn reference preserved", session.ActiveTurnID)
	}
}

func TestServiceGetDoesNotReconcileLiveRuntimeWaitingApprovalTurn(t *testing.T) {
	runtime := newFakeRuntime()
	activeTurnID := "synthetic-turn-1"
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{
		ID:          "session-1",
		WorkspaceID: "ws-1",
		Provider:    "claude-code",
		Status:      "created",
		TurnLifecycle: &TurnLifecycle{
			ActiveTurnID: &activeTurnID,
			Phase:        "waiting_approval",
		},
	}
	service := newIsolatedAgentService(runtime)
	service.SessionReader = fakeSessionReader{
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:          "session-1",
				WorkspaceID: "ws-1",
				Provider:    "claude-code",
			},
		},
	}
	service.MessageReader = fakeMessageReader{
		page: SessionMessagesPage{
			Messages: []SessionMessage{{
				TurnID: "synthetic-turn-1",
				Kind:   "tool_call",
				Status: "waiting_approval",
				Payload: map[string]any{
					"input": map[string]any{"toolName": "ExitPlanMode"},
				},
			}},
		},
	}

	_, err := service.Get(context.Background(), "ws-1", "session-1")
	if err != nil {
		t.Fatalf("Get returned error: %v", err)
	}
}

func TestServiceEnsureRuntimeSessionDoesNotReconcileLiveRuntimeWaitingApprovalTurn(t *testing.T) {
	runtime := newFakeRuntime()
	activeTurnID := "synthetic-turn-1"
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{
		ID:          "session-1",
		WorkspaceID: "ws-1",
		Provider:    "claude-code",
		Status:      "created",
		TurnLifecycle: &TurnLifecycle{
			ActiveTurnID: &activeTurnID,
			Phase:        "waiting_approval",
		},
	}
	service := newIsolatedAgentService(runtime)
	service.SessionReader = fakeSessionReader{
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:          "session-1",
				WorkspaceID: "ws-1",
				Provider:    "claude-code",
			},
		},
	}
	service.MessageReader = fakeMessageReader{
		page: SessionMessagesPage{
			Messages: []SessionMessage{{
				TurnID: "synthetic-turn-1",
				Kind:   "tool_call",
				Status: "waiting_approval",
				Payload: map[string]any{
					"input": map[string]any{"toolName": "ExitPlanMode"},
				},
			}},
		},
	}

	_, err := service.ensureRuntimeSessionResult(context.Background(), "ws-1", "session-1")
	if err != nil {
		t.Fatalf("ensureRuntimeSessionResult returned error: %v", err)
	}
}

func TestServiceEnsureRuntimeSessionDeletesStalePersistedHiddenLiveModelDiscoverySession(t *testing.T) {
	reader := fakeSessionReader{
		sessions: map[string]PersistedSession{
			"ws-1:hidden": {
				ID:          "hidden",
				WorkspaceID: "ws-1",
				Provider:    "claude-code",
				Cwd:         "/",
				Metadata:    agentactivitybiz.SessionMetadata{Visible: false},
			},
		},
	}
	service := newIsolatedAgentService(newFakeRuntime())
	service.SessionReader = reader

	_, err := service.ensureRuntimeSessionResult(context.Background(), "ws-1", "hidden")
	if !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("ensureRuntimeSessionResult error = %v, want %v", err, ErrSessionNotFound)
	}
	if _, ok := reader.sessions["ws-1:hidden"]; ok {
		t.Fatal("hidden discovery session still persisted, want deleted")
	}
}

func TestServiceGetDoesNotReconcileActionableInteractionFromStaleTranscript(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{
		ID:          "session-1",
		WorkspaceID: "ws-1",
		Provider:    "claude-code",
		Status:      "created",
	}
	service := newIsolatedAgentService(runtime)
	service.SessionReader = fakeSessionReader{
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:          "session-1",
				WorkspaceID: "ws-1",
				Provider:    "claude-code",
			},
		},
	}
	service.MessageReader = fakeMessageReader{
		page: SessionMessagesPage{
			Messages: []SessionMessage{{
				TurnID: "synthetic-turn-1",
				Kind:   "tool_call",
				Status: "waiting_approval",
				Payload: map[string]any{
					"input": map[string]any{
						"requestId": "plan-1",
						"toolName":  "ExitPlanMode",
					},
				},
			}},
		},
	}

	_, err := service.Get(context.Background(), "ws-1", "session-1")
	if err != nil {
		t.Fatalf("Get returned error: %v", err)
	}
}

func TestServiceResumesPersistedSessionWithPreparedRuntime(t *testing.T) {
	runtime := newFakeRuntime()
	var prepareInput runtimeprep.PrepareInput
	service := newIsolatedAgentService(runtime)
	service.AgentTargetStore = fakeAgentTargetStore{targets: defaultTestAgentTargets()}
	service.RuntimePreparer = fakeRuntimePreparer{
		input: &prepareInput,
		result: runtimeprep.PreparedRuntime{
			Cwd: "/prepared/workdir",
			Env: []string{"CODEX_HOME=/prepared/codex-home"},
		},
	}
	service.SessionReader = fakeSessionReader{
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:                "session-1",
				WorkspaceID:       "ws-1",
				AgentTargetID:     agenttargetbiz.IDLocalCodex,
				Provider:          "codex",
				ProviderSessionID: "provider-session-1",
				Cwd:               "/persisted/workdir",
				Settings: ComposerSettings{
					Model:            "gpt-5",
					PermissionModeID: "auto",
					ReasoningEffort:  "high",
				},
				ActiveTurnID:    "turn-1",
				Title:           "Persisted session",
				CreatedAtUnixMS: 1000,
				UpdatedAtUnixMS: 2000,
			},
		},
	}

	if _, err := service.SendInput(context.Background(), "ws-1", "session-1", SendInput{Content: TextPromptContent("hello")}); err != nil {
		t.Fatalf("SendInput returned error: %v", err)
	}
	if prepareInput.WorkspaceID != "ws-1" ||
		prepareInput.AgentSessionID != "session-1" ||
		prepareInput.Provider != "codex" ||
		prepareInput.Cwd != "/persisted/workdir" ||
		prepareInput.Model != "gpt-5" ||
		prepareInput.PermissionModeID != "auto" ||
		prepareInput.ReasoningEffort != "high" {
		t.Fatalf("prepare input = %#v, want persisted session metadata", prepareInput)
	}
	if len(runtime.resumeCalls) != 1 {
		t.Fatalf("resume calls = %d, want 1", len(runtime.resumeCalls))
	}
	resume := runtime.resumeCalls[0]
	if resume.Cwd != "/prepared/workdir" {
		t.Fatalf("resume cwd = %q, want prepared cwd", resume.Cwd)
	}
	if got := envValue(resume.Env, "CODEX_HOME"); got != "/prepared/codex-home" {
		t.Fatalf("resume CODEX_HOME = %q, env=%#v", got, resume.Env)
	}
	if got := envValue(resume.Env, agenthost.AgentCWDEnvironmentVariable); got != "/prepared/workdir" {
		t.Fatalf("resume caller cwd = %q, env=%#v", got, resume.Env)
	}
	placement, parseErr := agenthost.ParseAgentRailPlacementEnvironment(
		envValue(resume.Env, agenthost.AgentRailPlacementEnvironmentVariable),
	)
	if parseErr != nil || placement.Kind != agenthost.RailPlacementKindConversations {
		t.Fatalf("resume rail placement = %#v error=%v, env=%#v", placement, parseErr, resume.Env)
	}
	if resume.Settings.Model != "gpt-5" ||
		resume.Settings.PermissionModeID != "auto" ||
		resume.Settings.ReasoningEffort != "high" {
		t.Fatalf("resume settings = %#v, want persisted settings", resume.Settings)
	}
}

func TestServiceResumeClampsPersistedReasoningToSelectedModelCatalog(t *testing.T) {
	runtime := newFakeRuntime()
	var prepareInput runtimeprep.PrepareInput
	service := NewService(runtime)
	service.RuntimePreparer = fakeRuntimePreparer{
		input:  &prepareInput,
		result: runtimeprep.PreparedRuntime{Cwd: "/prepared/workdir"},
	}
	service.ModelCatalog = fakeModelCatalog{
		result: AgentModelCatalogResult{
			Provider: "codex",
			Source:   "codex-cli",
			Models: []AgentModelOption{{
				ID:                         "gpt-5.6-luna",
				DefaultReasoningEffort:     "high",
				ReasoningEffortsAdvertised: true,
				SupportedReasoningEfforts: []AgentModelReasoningEffortOption{
					{Value: "low"}, {Value: "medium"}, {Value: "high"},
				},
			}},
		},
	}
	service.SessionReader = fakeSessionReader{
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:          "session-1",
				WorkspaceID: "ws-1",
				Provider:    "codex",
				Cwd:         "/persisted/workdir",
				Settings: ComposerSettings{
					Model:           "gpt-5.6-luna",
					ReasoningEffort: "ultra",
				},
			},
		},
	}

	configureTestApplicationHost(service)
	if _, err := service.SendInput(
		context.Background(),
		"ws-1",
		"session-1",
		SendInput{Content: TextPromptContent("hello")},
	); err != nil {
		t.Fatalf("SendInput returned error: %v", err)
	}
	if prepareInput.ReasoningEffort != "high" {
		t.Fatalf("prepare reasoning effort = %q, want selected model default high", prepareInput.ReasoningEffort)
	}
	if len(runtime.resumeCalls) != 1 || runtime.resumeCalls[0].Settings.ReasoningEffort != "high" {
		t.Fatalf("resume calls = %#v, want selected model default high", runtime.resumeCalls)
	}
}

func TestServiceResumesPersistedSessionWithoutProviderSessionID(t *testing.T) {
	runtime := newFakeRuntime()
	service := newIsolatedAgentService(runtime)
	service.SessionReader = fakeSessionReader{
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:              "session-1",
				WorkspaceID:     "ws-1",
				Provider:        "codex",
				ActiveTurnID:    "turn-1",
				Title:           "Persisted session",
				CreatedAtUnixMS: 1000,
				UpdatedAtUnixMS: 2000,
			},
		},
	}

	if _, err := service.SendInput(
		context.Background(),
		"ws-1",
		"session-1",
		SendInput{Content: TextPromptContent("hello")},
	); err != nil {
		t.Fatalf("SendInput returned error: %v", err)
	}
	if len(runtime.resumeCalls) != 1 {
		t.Fatalf("resume calls = %d, want 1", len(runtime.resumeCalls))
	}
	if runtime.resumeCalls[0].ProviderSessionID != "" {
		t.Fatalf("provider session id = %q, want empty", runtime.resumeCalls[0].ProviderSessionID)
	}
}

func TestServiceListMessagesValidatesInputs(t *testing.T) {
	service := newIsolatedAgentService(newFakeRuntime())

	if _, err := service.ListMessages(
		context.Background(),
		"",
		"session-1",
		ListMessagesInput{},
	); err != ErrInvalidArgument {
		t.Fatalf("workspace validation error = %v, want %v", err, ErrInvalidArgument)
	}
	if _, err := service.ListMessages(
		context.Background(),
		"ws-1",
		"",
		ListMessagesInput{},
	); err != ErrInvalidArgument {
		t.Fatalf("session validation error = %v, want %v", err, ErrInvalidArgument)
	}
	if _, err := service.ListMessages(
		context.Background(),
		"ws-1",
		"session-1",
		ListMessagesInput{Limit: -1},
	); err != ErrInvalidArgument {
		t.Fatalf("limit validation error = %v, want %v", err, ErrInvalidArgument)
	}
}
