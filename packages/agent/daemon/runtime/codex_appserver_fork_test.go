package agentruntime

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
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
		if !capabilities.ThroughProviderTurnIDsKnown ||
			!reflect.DeepEqual(
				capabilities.ThroughProviderTurnIDs,
				[]string{"provider-turn-1", "provider-turn-2"},
			) {
			t.Fatalf("capabilities = %#v, want provider Turn projection", capabilities)
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
		transport.setConfigure(func(conn *scriptedAppServerConnection) {
			conn.userAgent = "codex/0.143.9"
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
		if capabilities.FullSession || capabilities.ThroughTurn ||
			capabilities.ThroughProviderTurnIDsKnown ||
			len(capabilities.ThroughProviderTurnIDs) != 0 {
			t.Fatalf("capabilities = %#v, want unsupported", capabilities)
		}
	})

	t.Run("tutti agent does not inherit codex capability", func(t *testing.T) {
		transport := &multiProcAppServerTransport{}
		transport.setConfigure(func(conn *scriptedAppServerConnection) {
			conn.userAgent = "codex/0.144.1"
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
		if capabilities.FullSession || capabilities.ThroughTurn ||
			capabilities.ThroughProviderTurnIDsKnown ||
			len(capabilities.ThroughProviderTurnIDs) != 0 {
			t.Fatalf("capabilities = %#v, want unsupported", capabilities)
		}
	})
}

func TestCodexAppServerForkCapabilitiesReadHistoricalRuntimeEveryTime(t *testing.T) {
	transport := &multiProcAppServerTransport{}
	transport.setConfigure(func(conn *scriptedAppServerConnection) {
		conn.userAgent = "codex/0.144.1"
	})
	adapter := NewCodexAppServerAdapter(transport)
	adapter.config.command = []string{writeFakeCodexExecutable(t, "v1"), "app-server"}
	source := testAppServerSession()
	source.ProviderSessionID = "codex-thread-1"

	for index := 0; index < 2; index++ {
		capabilities, err := adapter.ForkCapabilities(context.Background(), source)
		if err != nil {
			t.Fatalf("ForkCapabilities call %d: %v", index+1, err)
		}
		if capabilities.FullSession || !capabilities.ThroughTurn {
			t.Fatalf("capabilities = %#v, want through-turn only", capabilities)
		}
	}
	spawned, live := transport.snapshot()
	if spawned != 2 || len(live) != 0 {
		t.Fatalf("processes = spawned %d/live %d, want 2/0", spawned, len(live))
	}
	if adapter.HasLiveSession(source) {
		t.Fatal("historical capability probe registered a live session")
	}
}

func TestCodexAppServerForkCapabilitiesAreScopedToExactHistoricalLaunch(t *testing.T) {
	t.Run("different prepared cwd", func(t *testing.T) {
		transport := &multiProcAppServerTransport{}
		probes := 0
		transport.setConfigure(func(conn *scriptedAppServerConnection) {
			probes++
			if probes == 1 {
				conn.userAgent = "codex/0.144.1"
			} else {
				conn.userAgent = "codex/0.143.9"
			}
		})
		adapter := NewCodexAppServerAdapter(transport)
		adapter.config.command = []string{
			writeFakeCodexExecutable(t, "same-binary"),
			"app-server",
		}
		first := testAppServerSession()
		first.ProviderSessionID = "codex-thread-1"
		first.CWD = t.TempDir()
		second := first
		second.AgentSessionID = "agent-session-2"
		second.ProviderSessionID = "codex-thread-2"
		second.CWD = t.TempDir()

		supported, err := adapter.ForkCapabilities(t.Context(), first)
		if err != nil || !supported.ThroughTurn {
			t.Fatalf("first capabilities=%#v error=%v", supported, err)
		}
		unsupported, err := adapter.ForkCapabilities(t.Context(), second)
		if err != nil || unsupported.ThroughTurn {
			t.Fatalf("second capabilities=%#v error=%v", unsupported, err)
		}
		if spawned, _ := transport.snapshot(); spawned != 2 {
			t.Fatalf("historical probes=%d, want 2", spawned)
		}
	})

	t.Run("executable upgrade", func(t *testing.T) {
		transport := &multiProcAppServerTransport{}
		probes := 0
		transport.setConfigure(func(conn *scriptedAppServerConnection) {
			probes++
			if probes == 1 {
				conn.userAgent = "codex/0.143.9"
			} else {
				conn.userAgent = "codex/0.144.1"
			}
		})
		adapter := NewCodexAppServerAdapter(transport)
		executable := writeFakeCodexExecutable(t, "before-upgrade")
		adapter.config.command = []string{executable, "app-server"}
		source := testAppServerSession()
		source.ProviderSessionID = "codex-thread-1"

		before, err := adapter.ForkCapabilities(t.Context(), source)
		if err != nil || before.ThroughTurn {
			t.Fatalf("before capabilities=%#v error=%v", before, err)
		}
		upgraded := append(
			[]byte{0xcf, 0xfa, 0xed, 0xfe},
			[]byte("after-upgrade-longer")...,
		)
		if err := os.WriteFile(executable, upgraded, 0o755); err != nil {
			t.Fatal(err)
		}
		future := time.Now().Add(time.Second)
		if err := os.Chtimes(executable, future, future); err != nil {
			t.Fatal(err)
		}
		after, err := adapter.ForkCapabilities(t.Context(), source)
		if err != nil || !after.ThroughTurn {
			t.Fatalf("after capabilities=%#v error=%v", after, err)
		}
		if spawned, _ := transport.snapshot(); spawned != 2 {
			t.Fatalf("historical probes=%d, want 2", spawned)
		}
	})
}

func writeFakeCodexExecutable(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "codex")
	bytes := append([]byte{0xcf, 0xfa, 0xed, 0xfe}, []byte(content)...)
	if err := os.WriteFile(path, bytes, 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestCodexForkLaunchFingerprintHashesSensitiveMaterial(t *testing.T) {
	executable := writeFakeCodexExecutable(t, "fingerprint")
	fingerprint, cacheable := codexForkLaunchFingerprint(ProcessSpec{
		Command: []string{executable, "app-server"},
		Env:     []string{"CODEX_TEST_SECRET=do-not-retain"},
		CWD:     t.TempDir(),
	})
	if !cacheable {
		t.Fatal("native Codex launch was not cacheable")
	}
	if len(fingerprint) != sha256.Size*2 {
		t.Fatalf("fingerprint length=%d, want %d", len(fingerprint), sha256.Size*2)
	}
	if strings.Contains(fingerprint, "do-not-retain") ||
		strings.Contains(fingerprint, "CODEX_TEST_SECRET") {
		t.Fatalf("fingerprint retained sensitive environment: %q", fingerprint)
	}
}

func TestCodexForkLaunchFingerprintRejectsScriptAndSymlinkWrappers(t *testing.T) {
	for _, test := range []struct {
		name string
		path func(*testing.T) string
	}{
		{
			name: "direct shebang",
			path: func(t *testing.T) string {
				path := filepath.Join(t.TempDir(), "codex")
				if err := os.WriteFile(
					path,
					[]byte("#!/usr/bin/env node\nconsole.log('wrapper')\n"),
					0o755,
				); err != nil {
					t.Fatal(err)
				}
				return path
			},
		},
		{
			name: "symlink to shebang",
			path: func(t *testing.T) string {
				dir := t.TempDir()
				target := filepath.Join(dir, "codex.js")
				if err := os.WriteFile(
					target,
					[]byte("#!/usr/bin/env node\nconsole.log('wrapper')\n"),
					0o755,
				); err != nil {
					t.Fatal(err)
				}
				link := filepath.Join(dir, "codex")
				if err := os.Symlink(target, link); err != nil {
					t.Fatal(err)
				}
				return link
			},
		},
		{
			name: "package manager command",
			path: func(t *testing.T) string {
				path := filepath.Join(t.TempDir(), "npx")
				if err := os.WriteFile(
					path,
					append(
						[]byte{0xcf, 0xfa, 0xed, 0xfe},
						[]byte("package-manager")...,
					),
					0o755,
				); err != nil {
					t.Fatal(err)
				}
				return path
			},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			if fingerprint, cacheable := codexForkLaunchFingerprint(ProcessSpec{
				Command: []string{test.path(t), "app-server"},
			}); cacheable || fingerprint != "" {
				t.Fatalf(
					"wrapper fingerprint=%q cacheable=%v, want fail-closed",
					fingerprint,
					cacheable,
				)
			}
		})
	}
}

func TestCodexForkCapabilityCacheIsBoundedLRU(t *testing.T) {
	adapter := NewCodexAppServerAdapter(&multiProcAppServerTransport{})
	for index := 0; index < codexForkCapabilityCacheCapacity; index++ {
		adapter.cacheForkCapabilityVersion(
			fmt.Sprintf("fingerprint-%02d", index),
			[3]int{0, 144, index},
		)
	}
	if _, ok := adapter.cachedForkCapabilityVersion("fingerprint-00"); !ok {
		t.Fatal("cache did not contain the oldest entry before promotion")
	}
	adapter.cacheForkCapabilityVersion(
		"fingerprint-overflow",
		[3]int{0, 145, 0},
	)
	if len(adapter.forkCapabilityVersions) != codexForkCapabilityCacheCapacity ||
		len(adapter.forkCapabilityOrder) != codexForkCapabilityCacheCapacity {
		t.Fatalf(
			"cache sizes versions=%d order=%d, want %d",
			len(adapter.forkCapabilityVersions),
			len(adapter.forkCapabilityOrder),
			codexForkCapabilityCacheCapacity,
		)
	}
	if _, ok := adapter.forkCapabilityVersions["fingerprint-01"]; ok {
		t.Fatal("least-recently-used entry was not evicted")
	}
	if _, ok := adapter.forkCapabilityVersions["fingerprint-00"]; !ok {
		t.Fatal("recently promoted entry was evicted")
	}
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

func TestCodexAppServerForkedChildCanResumeAndStartTurn(t *testing.T) {
	adapter, source, transport := startForkCapableCodexAdapter(t)
	result, err := adapter.Fork(t.Context(), SessionForkInput{
		Source:         source,
		ProviderTurnID: "provider-turn-2",
	})
	if err != nil {
		t.Fatalf("Fork: %v", err)
	}

	transport.setConfigure(func(conn *scriptedAppServerConnection) {
		conn.userAgent = "codex/0.144.1"
		conn.holdTurn = true
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
	transport.setConfigure(func(conn *scriptedAppServerConnection) {
		conn.userAgent = "codex/0.144.1"
		conn.threadReadTurnIDs = []string{"provider-turn-1"}
	})

	result, err := adapter.Fork(t.Context(), SessionForkInput{
		Source:          source,
		ProviderTurnID:  "provider-turn-2",
		ProviderTurnIDs: []string{"provider-turn-1", "provider-turn-2"},
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
		configure func(*scriptedAppServerConnection)
	}{
		{
			name: "lineage missing",
			configure: func(conn *scriptedAppServerConnection) {
				conn.omitForkedFromThreadID = true
			},
		},
		{
			name: "lineage empty",
			configure: func(conn *scriptedAppServerConnection) {
				conn.emptyForkedFromThreadID = true
			},
		},
		{
			name: "lineage mismatch",
			configure: func(conn *scriptedAppServerConnection) {
				conn.forkedFromThreadID = "different-source"
			},
		},
		{
			name: "boundary mismatch",
			configure: func(conn *scriptedAppServerConnection) {
				conn.forkResponseLastTurnID = "different-turn"
			},
		},
		{
			name: "source returned as child",
			configure: func(conn *scriptedAppServerConnection) {
				conn.forkChildThreadID = "codex-thread-1"
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			adapter, source, transport := startForkCapableCodexAdapter(t)
			transport.setConfigure(func(conn *scriptedAppServerConnection) {
				conn.userAgent = "codex/0.144.1"
				test.configure(conn)
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
	transport.setConfigure(func(conn *scriptedAppServerConnection) {
		conn.userAgent = "codex/0.144.1"
		conn.forkRPCError = true
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

func TestCodexAppServerForkVerifiesExactProviderTurnPrefix(t *testing.T) {
	adapter, source, transport := startForkCapableCodexAdapter(t)
	transport.setConfigure(func(conn *scriptedAppServerConnection) {
		conn.userAgent = "codex/0.144.1"
		conn.forkResponseTurnIDs = []string{"provider-turn-1", "provider-turn-2"}
	})
	result, err := adapter.Fork(context.Background(), SessionForkInput{
		Source:          source,
		ProviderTurnID:  "provider-turn-2",
		ProviderTurnIDs: []string{"provider-turn-1", "provider-turn-2"},
	})
	if err != nil {
		t.Fatalf("Fork: %v", err)
	}
	if result.DeliveryDisposition != SessionForkDeliveryAccepted {
		t.Fatalf("result = %#v", result)
	}

	transport.setConfigure(func(conn *scriptedAppServerConnection) {
		conn.userAgent = "codex/0.144.1"
		conn.forkResponseTurnIDs = []string{"provider-turn-2"}
	})
	rejected, err := adapter.Fork(context.Background(), SessionForkInput{
		Source:          source,
		ProviderTurnID:  "provider-turn-2",
		ProviderTurnIDs: []string{"provider-turn-1", "provider-turn-2"},
	})
	if err == nil {
		t.Fatal("Fork succeeded with an incomplete provider prefix")
	}
	if rejected.DeliveryDisposition != SessionForkDeliveryUnknown {
		t.Fatalf("result = %#v, want delivery unknown", rejected)
	}
}

func TestControllerForkUsesOptionalSessionForkAdapter(t *testing.T) {
	transport := &multiProcAppServerTransport{}
	transport.setConfigure(func(conn *scriptedAppServerConnection) {
		conn.userAgent = "codex/0.144.1"
	})
	adapter := NewCodexAppServerAdapter(transport)
	adapter.config.command = []string{
		writeFakeCodexExecutable(t, "controller"),
		"app-server",
	}
	source := testAppServerSession()
	source.ProviderSessionID = "codex-thread-1"
	controller := NewController([]Adapter{adapter}, nil)

	capabilities, err := controller.ForkCapabilities(context.Background(), source)
	if err != nil {
		t.Fatalf("ForkCapabilities: %v", err)
	}
	if !capabilities.ThroughTurn {
		t.Fatalf("capabilities = %#v", capabilities)
	}
	result, err := controller.Fork(context.Background(), SessionForkInput{
		Source:         source,
		ProviderTurnID: "provider-turn-2",
	})
	if err != nil {
		t.Fatalf("Fork: %v", err)
	}
	if result.ProviderSessionID != "codex-thread-fork" {
		t.Fatalf("result = %#v", result)
	}
	spawned, live := transport.snapshot()
	if spawned != 3 || len(live) != 0 {
		t.Fatalf("processes = spawned %d/live %d, want 3/0", spawned, len(live))
	}
	if adapter.HasLiveSession(source) {
		t.Fatal("historical fork registered a live source session")
	}

	controller.mu.Lock()
	controller.turns[sessionKey(source.RoomID, source.AgentSessionID)] = activeTurn{
		turnID: "canonical-turn-running",
	}
	controller.mu.Unlock()
	_, err = controller.Fork(context.Background(), SessionForkInput{
		Source:         source,
		ProviderTurnID: "provider-turn-2",
	})
	if !errors.Is(err, ErrSessionActiveTurn) {
		t.Fatalf("Fork active turn error = %v, want %v", err, ErrSessionActiveTurn)
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
			version, ok := codexAppServerUserAgentVersion(map[string]any{
				"userAgent": test.userAgent,
			})
			got := ok && versionAtLeast(version, codexThroughTurnMinimumVersion)
			if got != test.want {
				t.Fatalf("gate(%q) = %v, want %v", test.userAgent, got, test.want)
			}
		})
	}
}

func startForkCapableCodexAdapter(
	t *testing.T,
) (*CodexAppServerAdapter, Session, *multiProcAppServerTransport) {
	t.Helper()
	transport := &multiProcAppServerTransport{}
	transport.setConfigure(func(conn *scriptedAppServerConnection) {
		conn.userAgent = "codex/0.144.1"
	})
	adapter := NewCodexAppServerAdapter(transport)
	source := testAppServerSession()
	if _, err := adapter.Start(context.Background(), source); err != nil {
		t.Fatalf("Start: %v", err)
	}
	source.ProviderSessionID = "codex-thread-1"
	return adapter, source, transport
}
