package agentruntime

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
)

func TestCodexAppServerForkCapabilitiesRequireExactSupportedRuntime(t *testing.T) {
	t.Run("supported codex", func(t *testing.T) {
		adapter, source, transport := startForkCapableCodexAdapter(t)
		capabilities, err := adapter.ForkCapabilities(context.Background(), source)
		if err != nil {
			t.Fatalf("ForkCapabilities: %v", err)
		}
		if capabilities.FullSession || !capabilities.ThroughTurn {
			t.Fatalf("capabilities = %#v, want through-turn only", capabilities)
		}
		if spawned, live := transport.snapshot(); spawned != 1 || len(live) != 1 {
			t.Fatalf(
				"capability probe processes = spawned %d/live %d, want existing 1/1",
				spawned,
				len(live),
			)
		}
	})

	t.Run("older codex", func(t *testing.T) {
		transport := &multiProcAppServerTransport{}
		transport.setConfigure(func(server *fakeCodexAppServer) {
			server.userAgent = "codex/0.143.9"
		})
		adapter := NewCodexAppServerAdapter(transport)
		source := testAppServerSession()
		if _, err := adapter.Start(context.Background(), source); err != nil {
			t.Fatalf("Start: %v", err)
		}
		source.ProviderSessionID = "codex-thread-1"
		capabilities, err := adapter.ForkCapabilities(context.Background(), source)
		if err != nil {
			t.Fatalf("ForkCapabilities: %v", err)
		}
		if capabilities.FullSession || capabilities.ThroughTurn {
			t.Fatalf("capabilities = %#v, want unsupported", capabilities)
		}
	})

	t.Run("supported tutti agent", func(t *testing.T) {
		transport := &multiProcAppServerTransport{}
		transport.setConfigure(func(server *fakeCodexAppServer) {
			server.userAgent = "tutti_agent/0.0.10"
		})
		adapter := NewTuttiAgentAppServerAdapterWithHostMetadata(
			transport,
			LegacyHostMetadata(),
		)
		source := testAppServerSession()
		source.Provider = ProviderTuttiAgent
		if _, err := adapter.Start(context.Background(), source); err != nil {
			t.Fatalf("Start: %v", err)
		}
		source.ProviderSessionID = "codex-thread-1"
		capabilities, err := adapter.ForkCapabilities(context.Background(), source)
		if err != nil {
			t.Fatalf("ForkCapabilities: %v", err)
		}
		if capabilities.FullSession || !capabilities.ThroughTurn {
			t.Fatalf("capabilities = %#v, want through-turn only", capabilities)
		}
	})

	t.Run("older tutti agent", func(t *testing.T) {
		transport := &multiProcAppServerTransport{}
		transport.setConfigure(func(server *fakeCodexAppServer) {
			server.userAgent = "tutti_agent/0.0.9"
		})
		adapter := NewTuttiAgentAppServerAdapterWithHostMetadata(
			transport,
			LegacyHostMetadata(),
		)
		source := testAppServerSession()
		source.Provider = ProviderTuttiAgent
		if _, err := adapter.Start(context.Background(), source); err != nil {
			t.Fatalf("Start: %v", err)
		}
		source.ProviderSessionID = "tutti-thread-1"
		capabilities, err := adapter.ForkCapabilities(context.Background(), source)
		if err != nil {
			t.Fatalf("ForkCapabilities: %v", err)
		}
		if capabilities.FullSession || capabilities.ThroughTurn {
			t.Fatalf("capabilities = %#v, want unsupported", capabilities)
		}
	})
}

func TestCodexAppServerForkCapabilitiesUsePersistedRuntimeAttestation(t *testing.T) {
	transport := &multiProcAppServerTransport{}
	adapter := NewCodexAppServerAdapter(transport)
	source := testAppServerSession()
	source.ProviderSessionID = "codex-thread-1"
	source.RuntimeContext = map[string]any{
		"agent": map[string]any{"userAgent": "codex/0.144.1"},
	}

	capabilities, err := adapter.ForkCapabilities(context.Background(), source)
	if err != nil {
		t.Fatalf("ForkCapabilities: %v", err)
	}
	if capabilities.FullSession || !capabilities.ThroughTurn {
		t.Fatalf("capabilities = %#v, want through-turn only", capabilities)
	}
	if spawned, live := transport.snapshot(); spawned != 0 || len(live) != 0 {
		t.Fatalf(
			"capability projection processes = spawned %d/live %d, want 0/0",
			spawned,
			len(live),
		)
	}
}

func TestTuttiAgentAppServerForkCapabilitiesUsePersistedRuntimeAttestation(
	t *testing.T,
) {
	transport := &multiProcAppServerTransport{}
	adapter := NewTuttiAgentAppServerAdapterWithHostMetadata(
		transport,
		LegacyHostMetadata(),
	)
	source := testAppServerSession()
	source.Provider = ProviderTuttiAgent
	source.ProviderSessionID = "codex-thread-1"
	source.RuntimeContext = map[string]any{
		"agent": map[string]any{"userAgent": "tutti_agent/0.0.10"},
	}

	capabilities, err := adapter.ForkCapabilities(t.Context(), source)
	if err != nil {
		t.Fatalf("ForkCapabilities: %v", err)
	}
	if capabilities.FullSession || !capabilities.ThroughTurn {
		t.Fatalf("capabilities = %#v, want through-turn only", capabilities)
	}
	if spawned, live := transport.snapshot(); spawned != 0 || len(live) != 0 {
		t.Fatalf(
			"capability projection processes = spawned %d/live %d, want 0/0",
			spawned,
			len(live),
		)
	}
}

func TestCodexAppServerForkCapabilitiesRequirePersistedAttestation(t *testing.T) {
	t.Run("missing attestation", func(t *testing.T) {
		transport := &multiProcAppServerTransport{}
		adapter := NewCodexAppServerAdapter(transport)
		source := testAppServerSession()
		source.ProviderSessionID = "codex-thread-1"

		capabilities, err := adapter.ForkCapabilities(t.Context(), source)
		if err != nil || capabilities.ThroughTurn {
			t.Fatalf("capabilities=%#v error=%v, want unsupported", capabilities, err)
		}
		if spawned, _ := transport.snapshot(); spawned != 0 {
			t.Fatalf("capability projection spawned=%d, want 0", spawned)
		}
	})

	t.Run("older persisted runtime", func(t *testing.T) {
		transport := &multiProcAppServerTransport{}
		adapter := NewCodexAppServerAdapter(transport)
		source := testAppServerSession()
		source.ProviderSessionID = "codex-thread-1"
		source.RuntimeContext = map[string]any{
			"agent": map[string]any{"userAgent": "codex/0.143.9"},
		}

		capabilities, err := adapter.ForkCapabilities(t.Context(), source)
		if err != nil || capabilities.ThroughTurn {
			t.Fatalf("capabilities=%#v error=%v, want unsupported", capabilities, err)
		}
		if spawned, _ := transport.snapshot(); spawned != 0 {
			t.Fatalf("capability projection spawned=%d, want 0", spawned)
		}
	})
}

func TestCodexAppServerForkThroughProviderTurn(t *testing.T) {
	adapter, source, transport := startForkCapableCodexAdapter(t)

	result, err := adapter.Fork(context.Background(), SessionForkInput{
		Source:         source,
		ProviderTurnID: "provider-turn-2",
	})
	if err != nil {
		t.Fatalf("Fork: %v", err)
	}
	if result.ProviderSessionID != "codex-thread-fork" ||
		result.ForkedFromProviderSessionID != source.ProviderSessionID ||
		result.ThroughProviderTurnID != "provider-turn-2" {
		t.Fatalf("result = %#v", result)
	}
	request := appServerRequestParams(
		t,
		transport.conn(1),
		appServerMethodThreadFork,
	)
	if got := asString(request["threadId"]); got != source.ProviderSessionID {
		t.Fatalf("threadId = %q, want %q", got, source.ProviderSessionID)
	}
	if got := asString(request["lastTurnId"]); got != "provider-turn-2" {
		t.Fatalf("lastTurnId = %q, want provider-turn-2", got)
	}
	for _, forbidden := range []string{"path", "cwd", "model", "config"} {
		if _, ok := request[forbidden]; ok {
			t.Fatalf("fork request unexpectedly contains %q: %#v", forbidden, request)
		}
	}
	spawned, live := transport.snapshot()
	if spawned != 2 || len(live) != 1 {
		t.Fatalf("processes = spawned %d/live %d, want 2/1", spawned, len(live))
	}
	if !adapter.HasLiveSession(source) {
		t.Fatal("source live session was closed by fork")
	}
}

func TestTuttiAgentAppServerForkThroughProviderTurn(t *testing.T) {
	transport := &multiProcAppServerTransport{}
	transport.setConfigure(func(server *fakeCodexAppServer) {
		server.userAgent = "tutti_agent/0.0.10"
		server.threadReadTurnIDs = []string{
			"provider-turn-1",
			"provider-turn-2",
		}
	})
	adapter := NewTuttiAgentAppServerAdapterWithHostMetadata(
		transport,
		LegacyHostMetadata(),
	)
	source := testAppServerSession()
	source.Provider = ProviderTuttiAgent
	if _, err := adapter.Start(t.Context(), source); err != nil {
		t.Fatalf("Start: %v", err)
	}
	source.ProviderSessionID = "codex-thread-1"
	controller := NewController([]Adapter{adapter}, nil)

	result, err := controller.Fork(t.Context(), SessionForkInput{
		Source:                  source,
		ProviderTurnID:          "provider-turn-2",
		ProviderTurnBindingJSON: json.RawMessage(`{"schemaVersion":1}`),
	})
	if err != nil {
		t.Fatalf("Fork: %v", err)
	}
	if result.ProviderSessionID != "codex-thread-fork" ||
		result.ForkedFromProviderSessionID != source.ProviderSessionID ||
		result.ThroughProviderTurnID != "provider-turn-2" {
		t.Fatalf("result = %#v", result)
	}
	request := appServerRequestParams(
		t,
		transport.conn(1),
		appServerMethodThreadFork,
	)
	if got := asString(request["lastTurnId"]); got != "provider-turn-2" {
		t.Fatalf("lastTurnId = %q, want provider-turn-2", got)
	}
}

func TestCodexAppServerForkedChildCanResumeAndStartTurn(t *testing.T) {
	adapter, source, transport := startForkCapableCodexAdapter(t)
	result, err := adapter.Fork(t.Context(), SessionForkInput{
		Source:         source,
		ProviderTurnID: "provider-turn-2",
	})
	if err != nil {
		t.Fatalf("Fork: %v", err)
	}

	transport.setConfigure(func(server *fakeCodexAppServer) {
		server.userAgent = "codex/0.144.1"
		server.holdTurn = true
	})
	target := source
	target.AgentSessionID = "agent-session-fork"
	target.ProviderSessionID = result.ProviderSessionID
	if err := adapter.Resume(t.Context(), target); err != nil {
		t.Fatalf("Resume forked child: %v", err)
	}
	if !adapter.HasLiveSession(target) {
		t.Fatal("forked child did not retain a live resumed session")
	}

	if err := adapter.ExecAsync(
		t.Context(),
		target,
		[]PromptContentBlock{{Type: "text", Text: "continue from fork"}},
		"",
		"canonical-fork-turn-1",
		nil,
		nil,
	); err != nil {
		t.Fatalf("ExecAsync forked child: %v", err)
	}
	targetConn := transport.conn(2)
	waitForCondition(t, func() bool {
		return len(appServerRequestParamsList(
			t,
			targetConn,
			appServerMethodTurnStart,
		)) == 1
	})
	turnStart := appServerRequestParams(
		t,
		targetConn,
		appServerMethodTurnStart,
	)
	if got := asString(turnStart["threadId"]); got != result.ProviderSessionID {
		t.Fatalf(
			"forked child turn/start threadId = %q, want %q",
			got,
			result.ProviderSessionID,
		)
	}
	if !adapter.HasLiveSession(source) {
		t.Fatal("resuming forked child replaced the source live session")
	}
	if err := adapter.Close(t.Context(), target); err != nil {
		t.Fatalf("Close forked child: %v", err)
	}
}

func TestCodexAppServerForkRejectsUnavailableBoundaryBeforeProviderMutation(
	t *testing.T,
) {
	adapter, source, transport := startForkCapableCodexAdapter(t)
	transport.setConfigure(func(server *fakeCodexAppServer) {
		server.userAgent = "codex/0.144.1"
		server.threadReadTurnIDs = []string{"provider-turn-1"}
	})

	result, err := adapter.Fork(t.Context(), SessionForkInput{
		Source:         source,
		ProviderTurnID: "provider-turn-2",
	})
	if err == nil ||
		result.DeliveryDisposition != SessionForkDeliveryNotStarted {
		t.Fatalf("Fork() result=%#v error=%v, want not-started", result, err)
	}
	if requests := appServerRequestParamsList(
		t,
		transport.conn(1),
		appServerMethodThreadFork,
	); len(requests) != 0 {
		t.Fatalf("thread/fork requests=%d, want zero", len(requests))
	}
}

func TestCodexAppServerForkRejectsUnverifiedChild(t *testing.T) {
	tests := []struct {
		name      string
		configure func(*fakeCodexAppServer)
	}{
		{
			name: "lineage missing",
			configure: func(server *fakeCodexAppServer) {
				server.omitForkedFromThreadID = true
			},
		},
		{
			name: "lineage empty",
			configure: func(server *fakeCodexAppServer) {
				server.emptyForkedFromThreadID = true
			},
		},
		{
			name: "lineage mismatch",
			configure: func(server *fakeCodexAppServer) {
				server.forkedFromThreadID = "different-source"
			},
		},
		{
			name: "boundary mismatch",
			configure: func(server *fakeCodexAppServer) {
				server.forkResponseLastTurnID = "different-turn"
			},
		},
		{
			name: "source returned as child",
			configure: func(server *fakeCodexAppServer) {
				server.forkChildThreadID = "codex-thread-1"
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			adapter, source, transport := startForkCapableCodexAdapter(t)
			transport.setConfigure(func(server *fakeCodexAppServer) {
				server.userAgent = "codex/0.144.1"
				test.configure(server)
			})
			result, err := adapter.Fork(context.Background(), SessionForkInput{
				Source:         source,
				ProviderTurnID: "provider-turn-2",
			})
			if err == nil {
				t.Fatal("Fork succeeded, want verification error")
			}
			if result.DeliveryDisposition != SessionForkDeliveryUnknown {
				t.Fatalf(
					"delivery disposition = %q, want %q",
					result.DeliveryDisposition,
					SessionForkDeliveryUnknown,
				)
			}
		})
	}
}

func TestCodexAppServerForkClassifiesExplicitRPCRejection(t *testing.T) {
	adapter, source, transport := startForkCapableCodexAdapter(t)
	transport.setConfigure(func(server *fakeCodexAppServer) {
		server.userAgent = "codex/0.144.1"
		server.forkRPCError = true
	})
	result, err := adapter.Fork(context.Background(), SessionForkInput{
		Source:         source,
		ProviderTurnID: "provider-turn-2",
	})
	if err == nil {
		t.Fatal("Fork succeeded, want explicit provider rejection")
	}
	if result.DeliveryDisposition != SessionForkDeliveryRejected {
		t.Fatalf(
			"delivery disposition = %q, want %q",
			result.DeliveryDisposition,
			SessionForkDeliveryRejected,
		)
	}
}

func TestCodexAppServerForkVerifiesSelectedProviderTurnBinding(t *testing.T) {
	adapter, source, transport := startForkCapableCodexAdapter(t)
	transport.setConfigure(func(server *fakeCodexAppServer) {
		server.userAgent = "codex/0.144.1"
		server.forkResponseTurnIDs = []string{"provider-turn-1", "provider-turn-2"}
	})
	result, err := adapter.Fork(context.Background(), SessionForkInput{
		Source:         source,
		ProviderTurnID: "provider-turn-2",
	})
	if err != nil {
		t.Fatalf("Fork: %v", err)
	}
	if result.DeliveryDisposition != SessionForkDeliveryAccepted {
		t.Fatalf("result = %#v", result)
	}

	transport.setConfigure(func(server *fakeCodexAppServer) {
		server.userAgent = "codex/0.144.1"
		server.forkResponseTurnIDs = []string{"provider-turn-2"}
	})
	selectedOnly, err := adapter.Fork(context.Background(), SessionForkInput{
		Source:         source,
		ProviderTurnID: "provider-turn-2",
	})
	if err != nil || selectedOnly.DeliveryDisposition != SessionForkDeliveryAccepted {
		t.Fatalf("selected-only Fork result=%#v error=%v", selectedOnly, err)
	}

	transport.setConfigure(func(server *fakeCodexAppServer) {
		server.userAgent = "codex/0.144.1"
		server.forkResponseTurnIDs = []string{"provider-turn-1"}
	})
	rejected, err := adapter.Fork(context.Background(), SessionForkInput{
		Source:         source,
		ProviderTurnID: "provider-turn-2",
	})
	if err == nil || rejected.DeliveryDisposition != SessionForkDeliveryUnknown {
		t.Fatalf("missing selected binding result=%#v error=%v", rejected, err)
	}
}

func TestControllerForkUsesOptionalSessionForkAdapter(t *testing.T) {
	transport := &multiProcAppServerTransport{}
	transport.setConfigure(func(server *fakeCodexAppServer) {
		server.userAgent = "codex/0.144.1"
	})
	adapter := NewCodexAppServerAdapter(transport)
	source := testAppServerSession()
	source.ProviderSessionID = "codex-thread-1"
	source.RuntimeContext = map[string]any{
		"agent": map[string]any{"userAgent": "codex/0.144.1"},
	}
	controller := NewController([]Adapter{adapter}, nil)

	capabilities, err := controller.ForkCapabilities(context.Background(), source)
	if err != nil {
		t.Fatalf("ForkCapabilities: %v", err)
	}
	if !capabilities.ThroughTurn {
		t.Fatalf("capabilities = %#v", capabilities)
	}
	result, err := controller.Fork(context.Background(), SessionForkInput{
		Source:                  source,
		ProviderTurnID:          "provider-turn-2",
		ProviderTurnBindingJSON: []byte(`{"schemaVersion":1}`),
	})
	if err != nil {
		t.Fatalf("Fork: %v", err)
	}
	if result.ProviderSessionID != "codex-thread-fork" {
		t.Fatalf("result = %#v", result)
	}
	spawned, live := transport.snapshot()
	if spawned != 1 || len(live) != 0 {
		t.Fatalf("processes = spawned %d/live %d, want 1/0", spawned, len(live))
	}
	if adapter.HasLiveSession(source) {
		t.Fatal("historical fork registered a live source session")
	}

	controller.mu.Lock()
	controller.turns[sessionKey(source.RoomID, source.AgentSessionID)] = activeTurn{
		turnID: "canonical-turn-running",
	}
	controller.mu.Unlock()
	activeResult, err := controller.Fork(context.Background(), SessionForkInput{
		Source:                  source,
		ProviderTurnID:          "provider-turn-2",
		ProviderTurnBindingJSON: []byte(`{"schemaVersion":1}`),
	})
	if err != nil || activeResult.DeliveryDisposition != SessionForkDeliveryAccepted {
		t.Fatalf("Fork active turn result=%#v error=%v", activeResult, err)
	}
}

func TestControllerForkClassifiesSourcePreparationFailureAsNotStarted(t *testing.T) {
	source := testAppServerSession()
	source.ProviderSessionID = "codex-thread-1"

	tests := []struct {
		name       string
		controller *Controller
		mutate     func(*Session)
	}{
		{
			name:       "invalid source",
			controller: NewController(nil, nil),
			mutate: func(source *Session) {
				source.Provider = ""
			},
		},
		{
			name: "adapter resolution failure",
			controller: NewControllerWithAdapterResolver(
				nil,
				nil,
				sessionForkErrorAdapterResolver{},
			),
			mutate: func(*Session) {},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			testSource := source
			test.mutate(&testSource)
			result, err := test.controller.Fork(
				context.Background(),
				SessionForkInput{
					Source:         testSource,
					ProviderTurnID: "provider-turn-2",
				},
			)
			if err == nil {
				t.Fatal("Fork succeeded, want source preparation error")
			}
			if result.DeliveryDisposition != SessionForkDeliveryNotStarted {
				t.Fatalf(
					"delivery disposition = %q, want %q",
					result.DeliveryDisposition,
					SessionForkDeliveryNotStarted,
				)
			}
		})
	}
}

type sessionForkErrorAdapterResolver struct{}

func (sessionForkErrorAdapterResolver) ResolveAdapter(
	context.Context,
	AdapterResolveInput,
) (Adapter, error) {
	return nil, errors.New("session fork adapter resolution failed")
}

func TestCodexAppServerUserAgentVersionGate(t *testing.T) {
	strategy := appServerForkStrategyForTest(t, ProviderCodex)
	tests := []struct {
		userAgent string
		want      bool
	}{
		{userAgent: "codex/0.144.0", want: true},
		{userAgent: "codex-cli 0.145.2", want: true},
		{userAgent: "codex/0.143.99", want: false},
		{userAgent: "codex/0.146.0-alpha.3.1", want: true},
		{userAgent: "tutti-agent/9.0.0", want: false},
		{userAgent: "", want: false},
	}
	for _, test := range tests {
		t.Run(test.userAgent, func(t *testing.T) {
			version, ok := appServerForkVersion(
				strategy,
				map[string]any{"userAgent": test.userAgent},
			)
			got := ok && versionAtLeast(
				version,
				strategy.throughTurnMinimumVersion,
			)
			if got != test.want {
				t.Fatalf("gate(%q) = %v, want %v", test.userAgent, got, test.want)
			}
		})
	}
}

func TestTuttiAgentAppServerUserAgentVersionGate(t *testing.T) {
	strategy := appServerForkStrategyForTest(t, ProviderTuttiAgent)
	tests := []struct {
		userAgent string
		want      bool
	}{
		{userAgent: "tutti_agent/0.0.10", want: true},
		{
			userAgent: "tutti_agent/0.0.10 (Mac OS 26.5.0; arm64) dumb",
			want:      true,
		},
		{userAgent: "tutti-agent/0.0.9", want: false},
		{userAgent: "codex/0.144.0", want: false},
		{userAgent: "", want: false},
	}
	for _, test := range tests {
		t.Run(test.userAgent, func(t *testing.T) {
			version, ok := appServerForkVersion(
				strategy,
				map[string]any{"userAgent": test.userAgent},
			)
			got := ok && versionAtLeast(
				version,
				strategy.throughTurnMinimumVersion,
			)
			if got != test.want {
				t.Fatalf(
					"gate(%q) = %v, want %v",
					test.userAgent,
					got,
					test.want,
				)
			}
		})
	}
}

func startForkCapableCodexAdapter(
	t *testing.T,
) (*CodexAppServerAdapter, Session, *multiProcAppServerTransport) {
	t.Helper()
	transport := &multiProcAppServerTransport{}
	transport.setConfigure(func(server *fakeCodexAppServer) {
		server.userAgent = "codex/0.144.1"
		server.threadReadTurnIDs = []string{"provider-turn-1", "provider-turn-2"}
	})
	adapter := NewCodexAppServerAdapter(transport)
	source := testAppServerSession()
	if _, err := adapter.Start(context.Background(), source); err != nil {
		t.Fatalf("Start: %v", err)
	}
	source.ProviderSessionID = "codex-thread-1"
	return adapter, source, transport
}
