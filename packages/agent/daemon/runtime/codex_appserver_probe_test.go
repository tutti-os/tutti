package agentruntime

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"
)

func TestProbeCodexAppServerCompletesFormalInitialize(t *testing.T) {
	t.Parallel()
	transport := newScriptedAppServerTransport()
	result := ProbeCodexAppServer(context.Background(), CodexAppServerProbeInput{
		Command: []string{"codex", "app-server"}, Transport: transport,
		HandshakeTimeout: time.Second,
	})
	if !result.CommandStarted || !result.ProtocolReady {
		t.Fatalf("probe = %#v, want command and protocol ready", result)
	}
	if got := len(appServerRequestParamsList(t, transport.conn, appServerMethodInitialize)); got != 1 {
		t.Fatalf("initialize calls = %d, want 1", got)
	}
	if got := len(appServerRequestParamsList(t, transport.conn, appServerMethodInitialized)); got != 1 {
		t.Fatalf("initialized notifications = %d, want 1", got)
	}
	if result.CommandStarted != result.ProtocolReady && result.ProtocolReady {
		t.Fatalf("protocol-ready invariant violated: %#v", result)
	}
	assertScriptedProbeConnectionClosed(t, transport.conn)
}

func TestProbeCodexAppServerStartsExactlyOneProcess(t *testing.T) {
	t.Parallel()
	transport := newScriptedAppServerTransport()
	result := ProbeCodexAppServer(context.Background(), CodexAppServerProbeInput{
		Command: []string{"codex", "app-server"}, Transport: transport,
	})
	if !result.ProtocolReady {
		t.Fatalf("probe = %#v, want protocol ready", result)
	}
	transport.mu.Lock()
	starts := len(transport.specs)
	transport.mu.Unlock()
	if starts != 1 {
		t.Fatalf("Start calls = %d, want 1", starts)
	}
}

func TestProbeCodexAppServerReadsAuthenticatedAccount(t *testing.T) {
	t.Parallel()
	transport := newScriptedAppServerTransport()
	result := ProbeCodexAppServer(context.Background(), CodexAppServerProbeInput{
		Command: []string{"codex", "app-server"}, Transport: transport,
		HandshakeTimeout: time.Second, ReadAccount: true,
	})
	if !result.ProtocolReady || !result.AccountRead ||
		result.AccountState != CodexAppServerAccountAuthenticated {
		t.Fatalf("probe = %#v, want authenticated account/read", result)
	}
	if result.AuthMethod != "chatgpt" || result.AccountLabel != "dev@example.com" {
		t.Fatalf("account identity = %q / %q, want chatgpt / dev@example.com", result.AuthMethod, result.AccountLabel)
	}
	if got := len(appServerRequestParamsList(t, transport.conn, appServerMethodAccountRead)); got != 1 {
		t.Fatalf("account/read calls = %d, want 1", got)
	}
	assertScriptedProbeConnectionClosed(t, transport.conn)
}

func TestProbeCodexAppServerReadsRequiredAccount(t *testing.T) {
	t.Parallel()
	transport := newScriptedAppServerTransport()
	transport.server.requiresAuth = true
	result := ProbeCodexAppServer(context.Background(), CodexAppServerProbeInput{
		Command: []string{"codex", "app-server"}, Transport: transport,
		HandshakeTimeout: time.Second, ReadAccount: true,
	})
	if !result.ProtocolReady || !result.AccountRead ||
		result.AccountState != CodexAppServerAccountRequired {
		t.Fatalf("probe = %#v, want required account/read", result)
	}
	assertScriptedProbeConnectionClosed(t, transport.conn)
}

func TestProbeCodexAppServerDoesNotAuthenticateAccountReadFailure(t *testing.T) {
	t.Parallel()
	transport := newScriptedAppServerTransport()
	transport.server.accountReadError = true
	transport.server.accountReadErrorCode = -32600
	transport.server.accountReadErrorMessage = "plan type is required for chatgpt authentication"
	result := ProbeCodexAppServer(context.Background(), CodexAppServerProbeInput{
		Command: []string{"codex", "app-server"}, Transport: transport,
		HandshakeTimeout: time.Second, ReadAccount: true,
	})
	if !result.ProtocolReady || result.AccountRead ||
		result.AccountState != CodexAppServerAccountUnknown {
		t.Fatalf("probe = %#v, want unknown account after account/read failure", result)
	}
	if result.AccountCategory != CodexProbeProtocolFailure {
		t.Fatalf("account category = %q, want %q", result.AccountCategory, CodexProbeProtocolFailure)
	}
	assertScriptedProbeConnectionClosed(t, transport.conn)
}

func TestProbeCodexAppServerReadsProviderRateLimits(t *testing.T) {
	t.Parallel()
	transport := newScriptedAppServerTransport()
	result := ProbeCodexAppServer(context.Background(), CodexAppServerProbeInput{
		Command: []string{"codex", "app-server"}, Transport: transport,
		HandshakeTimeout: time.Second, ReadRateLimits: true,
	})
	if !result.ProtocolReady || !result.RateLimitsRead || result.Category != "" {
		t.Fatalf("probe = %#v, want successful rate limits read", result)
	}
	if got := len(appServerRequestParamsList(t, transport.conn, appServerMethodRateLimitsRead)); got != 1 {
		t.Fatalf("account/rateLimits/read calls = %d, want 1", got)
	}
	assertScriptedProbeConnectionClosed(t, transport.conn)
}

func TestProbeCodexAppServerReturnsRateLimitsAuthenticationFailure(t *testing.T) {
	t.Parallel()
	transport := newScriptedAppServerTransport()
	transport.server.rateLimitsReadError = true
	transport.server.rateLimitsReadErrorCode = -32001
	transport.server.rateLimitsReadErrorMessage = "401 Unauthorized: refresh token was revoked"
	result := ProbeCodexAppServer(context.Background(), CodexAppServerProbeInput{
		Command: []string{"codex", "app-server"}, Transport: transport,
		HandshakeTimeout: time.Second, ReadRateLimits: true,
	})
	if !result.ProtocolReady || result.RateLimitsRead ||
		result.RateLimitsCategory != CodexProbeProtocolFailure ||
		!strings.Contains(result.Message, "refresh token was revoked") {
		t.Fatalf("probe = %#v, want rate limits authentication failure", result)
	}
	assertScriptedProbeConnectionClosed(t, transport.conn)
}

func TestParseCodexProbeAccountRejectsIncompleteResponses(t *testing.T) {
	t.Parallel()
	for _, raw := range []string{
		`{}`,
		`{"requiresOpenaiAuth":false,"account":{}}`,
		`{"requiresOpenaiAuth":false,"account":{"type":"chatgpt","email":"dev@example.com"}}`,
		`{"requiresOpenaiAuth":false,"account":{"type":"unexpected"}}`,
	} {
		if account, ok := parseCodexProbeAccount(json.RawMessage(raw)); ok {
			t.Fatalf("parseCodexProbeAccount(%s) = %#v, true; want invalid", raw, account)
		}
	}
}

func TestProbeCodexAppServerTimesOutDuringStart(t *testing.T) {
	t.Parallel()
	transport := &blockingStartProbeTransport{entered: make(chan struct{})}
	result := ProbeCodexAppServer(context.Background(), CodexAppServerProbeInput{
		Command: []string{"codex", "app-server"}, Transport: transport, StartupTimeout: 20 * time.Millisecond,
	})
	if result.CommandStarted || result.ProtocolReady || result.Category != CodexProbeStartupTimeout {
		t.Fatalf("probe = %#v, want startup timeout before command start", result)
	}
	if got := transport.calls.Load(); got != 1 {
		t.Fatalf("Start calls = %d, want 1", got)
	}
}

func TestProbeCodexAppServerCancellationDuringHandshake(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	connection := newScriptedAppServerConnection()
	transport := &cancellationProbeTransport{conn: connection, initializeSent: make(chan struct{})}
	done := make(chan CodexAppServerProbeResult, 1)
	go func() {
		done <- ProbeCodexAppServer(ctx, CodexAppServerProbeInput{
			Command: []string{"codex", "app-server"}, Transport: transport, HandshakeTimeout: time.Second,
		})
	}()
	select {
	case <-transport.initializeSent:
	case <-time.After(time.Second):
		t.Fatal("initialize was not sent")
	}
	cancel()
	select {
	case result := <-done:
		if !result.CommandStarted || result.ProtocolReady || result.Category != CodexProbeCanceled {
			t.Fatalf("probe = %#v, want canceled handshake", result)
		}
	case <-time.After(time.Second):
		t.Fatal("probe did not return after cancellation")
	}
	assertScriptedProbeConnectionClosed(t, connection)
}

func TestProbeCodexAppServerBoundsStderr(t *testing.T) {
	t.Parallel()
	connection := newNoisyProbeConnection(10 << 20)
	result := ProbeCodexAppServer(context.Background(), CodexAppServerProbeInput{
		Command: []string{"codex", "app-server"}, Transport: noisyProbeTransport{conn: connection},
		HandshakeTimeout: time.Second,
	})
	if len(result.StderrTail) > acpClientOutputTailLimit {
		t.Fatalf("stderr result = %#v, want bounded tail", result)
	}
	if !utf8.ValidString(result.StderrTail) {
		t.Fatalf("stderr tail is not UTF-8: %q", result.StderrTail)
	}
	select {
	case <-connection.producerDone:
	case <-time.After(time.Second):
		t.Fatal("stderr producer did not stop")
	}
	assertScriptedProbeConnectionClosed(t, connection.scriptedAppServerConnection)
}

func TestProbeCodexAppServerReapsLocalHelperProcess(t *testing.T) {
	pidPath := filepath.Join(t.TempDir(), "probe-helper.pid")
	result := ProbeCodexAppServer(context.Background(), CodexAppServerProbeInput{
		Command:          []string{os.Args[0], "-test.run=^TestProbeCodexAppServerHelperProcess$", "--"},
		Env:              []string{"TUTTI_CODEX_PROBE_HELPER=1", "TUTTI_CODEX_PROBE_PID_PATH=" + pidPath},
		HandshakeTimeout: 100 * time.Millisecond,
		ShutdownTimeout:  100 * time.Millisecond,
	})
	if result.ProtocolReady || result.Category != CodexProbeHandshakeTimeout {
		t.Fatalf("probe = %#v, want bounded local-helper timeout", result)
	}
	if _, err := os.ReadFile(pidPath); err != nil {
		t.Fatalf("helper did not start or write pid: %v", err)
	}
	// Probe only returns after localProcessConnection.Close has waited for the
	// child. This is a real ProcessTransport integration test, not a fake
	// connection Close assertion.
}

func TestProbeCodexAppServerHelperProcess(_ *testing.T) {
	if os.Getenv("TUTTI_CODEX_PROBE_HELPER") != "1" {
		return
	}
	if pidPath := os.Getenv("TUTTI_CODEX_PROBE_PID_PATH"); pidPath != "" {
		if err := os.WriteFile(pidPath, []byte(fmt.Sprint(os.Getpid())), 0o600); err != nil {
			os.Exit(2)
		}
	}
	_, _ = os.Stderr.Write(make([]byte, 10<<20))
	for {
		time.Sleep(time.Second)
	}
}

func TestProbeCodexAppServerTimesOutWithoutInitializeResponse(t *testing.T) {
	t.Parallel()
	transport := &silentProbeTransport{conn: newScriptedAppServerConnection()}
	result := ProbeCodexAppServer(context.Background(), CodexAppServerProbeInput{
		Command: []string{"codex", "app-server"}, Transport: transport,
		HandshakeTimeout: 20 * time.Millisecond,
	})
	if !result.CommandStarted || result.ProtocolReady || result.Category != CodexProbeHandshakeTimeout {
		t.Fatalf("probe = %#v, want command pass plus handshake timeout", result)
	}
	assertScriptedProbeConnectionClosed(t, transport.conn)
}

func TestProbeCodexAppServerRejectsInitializeErrorAndInitializedSendFailure(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		name      string
		transport ProcessTransport
		want      string
	}{
		{
			name:      "initialize error response",
			transport: &initializeErrorProbeTransport{conn: newScriptedAppServerConnection()},
			want:      CodexProbeProtocolFailure,
		},
		{
			name:      "initialized send failure",
			transport: &initializedSendFailureProbeTransport{conn: newScriptedAppServerConnection()},
			want:      CodexProbeProtocolFailure,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			result := ProbeCodexAppServer(context.Background(), CodexAppServerProbeInput{
				Command: []string{"codex", "app-server"}, Transport: test.transport, HandshakeTimeout: time.Second,
			})
			if !result.CommandStarted || result.ProtocolReady || result.Category != test.want {
				t.Fatalf("probe = %#v, want %s", result, test.want)
			}
			var connection *scriptedAppServerConnection
			switch transport := test.transport.(type) {
			case *initializeErrorProbeTransport:
				connection = transport.conn
			case *initializedSendFailureProbeTransport:
				connection = transport.conn
			}
			assertScriptedProbeConnectionClosed(t, connection)
		})
	}
}

func TestProbeCodexAppServerRejectsMalformedResponseAndCloses(t *testing.T) {
	t.Parallel()
	connection := newScriptedAppServerConnection()
	transport := &invalidProbeTransport{conn: connection}
	result := ProbeCodexAppServer(context.Background(), CodexAppServerProbeInput{
		Command: []string{"codex", "app-server"}, Transport: transport,
		HandshakeTimeout: time.Second,
	})
	if !result.CommandStarted || result.ProtocolReady || result.Category != CodexProbeInvalidResponse {
		t.Fatalf("probe = %#v, want malformed protocol failure", result)
	}
	assertScriptedProbeConnectionClosed(t, connection)
}

func TestProbeCodexAppServerCancellationClosesTransport(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	transport := &silentProbeTransport{conn: newScriptedAppServerConnection()}
	result := ProbeCodexAppServer(ctx, CodexAppServerProbeInput{
		Command: []string{"codex", "app-server"}, Transport: transport,
		HandshakeTimeout: time.Second,
	})
	if result.CommandStarted || result.ProtocolReady || result.Category != CodexProbeCanceled {
		t.Fatalf("probe = %#v, want canceled startup", result)
	}
}

type silentProbeTransport struct{ conn *scriptedAppServerConnection }

func (t *silentProbeTransport) Start(_ context.Context, _ ProcessSpec) (ProcessConnection, error) {
	return &silentProbeConnection{scriptedAppServerConnection: t.conn}, nil
}

type silentProbeConnection struct{ *scriptedAppServerConnection }

func (*silentProbeConnection) Send([]byte) error { return nil }

type invalidProbeTransport struct{ conn *scriptedAppServerConnection }

func (t *invalidProbeTransport) Start(_ context.Context, _ ProcessSpec) (ProcessConnection, error) {
	return &invalidProbeConnection{scriptedAppServerConnection: t.conn}, nil
}

type invalidProbeConnection struct{ *scriptedAppServerConnection }

func (c *invalidProbeConnection) Send([]byte) error {
	for range acpClientStdoutProtocolErrorLimit {
		c.recv <- ProcessFrame{Stdout: []byte("not-json\n")}
	}
	return nil
}

type initializeErrorProbeTransport struct{ conn *scriptedAppServerConnection }

func (t *initializeErrorProbeTransport) Start(context.Context, ProcessSpec) (ProcessConnection, error) {
	return &initializeErrorProbeConnection{scriptedAppServerConnection: t.conn}, nil
}

type initializeErrorProbeConnection struct{ *scriptedAppServerConnection }

func (c *initializeErrorProbeConnection) Send(data []byte) error {
	for _, line := range acpScanLines(data) {
		var request struct {
			ID json.RawMessage `json:"id"`
		}
		_ = json.Unmarshal([]byte(line), &request)
		c.sendJSON(map[string]any{"id": request.ID, "error": map[string]any{"code": -32000, "message": "initialize rejected"}})
	}
	return nil
}

type initializedSendFailureProbeTransport struct{ conn *scriptedAppServerConnection }

func (t *initializedSendFailureProbeTransport) Start(context.Context, ProcessSpec) (ProcessConnection, error) {
	return &initializedSendFailureProbeConnection{scriptedAppServerConnection: t.conn}, nil
}

type initializedSendFailureProbeConnection struct {
	*scriptedAppServerConnection
	calls int
}

func (c *initializedSendFailureProbeConnection) Send(data []byte) error {
	c.calls++
	if c.calls == 2 {
		return fmt.Errorf("initialized write failed")
	}
	return c.scriptedAppServerConnection.Send(data)
}

func assertScriptedProbeConnectionClosed(t *testing.T, connection *scriptedAppServerConnection) {
	t.Helper()
	connection.mu.Lock()
	closed := connection.closeCount
	connection.mu.Unlock()
	if closed != 1 {
		t.Fatalf("connection close count = %d, want 1", closed)
	}
}

type blockingStartProbeTransport struct {
	calls   atomic.Int32
	entered chan struct{}
}

func (t *blockingStartProbeTransport) Start(ctx context.Context, _ ProcessSpec) (ProcessConnection, error) {
	t.calls.Add(1)
	select {
	case t.entered <- struct{}{}:
	default:
	}
	<-ctx.Done()
	return nil, ctx.Err()
}

type cancellationProbeTransport struct {
	conn           *scriptedAppServerConnection
	initializeSent chan struct{}
}

func (t *cancellationProbeTransport) Start(context.Context, ProcessSpec) (ProcessConnection, error) {
	return &cancellationProbeConnection{scriptedAppServerConnection: t.conn, initializeSent: t.initializeSent}, nil
}

type cancellationProbeConnection struct {
	*scriptedAppServerConnection
	initializeSent chan struct{}
	once           sync.Once
}

func (c *cancellationProbeConnection) Send(_ []byte) error {
	c.once.Do(func() { close(c.initializeSent) })
	return nil
}

type noisyProbeTransport struct{ conn *noisyProbeConnection }

func (t noisyProbeTransport) Start(context.Context, ProcessSpec) (ProcessConnection, error) {
	return t.conn, nil
}

type noisyProbeConnection struct {
	*scriptedAppServerConnection
	bytesToWrite int
	producerDone chan struct{}
	once         sync.Once
}

func newNoisyProbeConnection(bytesToWrite int) *noisyProbeConnection {
	return &noisyProbeConnection{scriptedAppServerConnection: newScriptedAppServerConnection(), bytesToWrite: bytesToWrite, producerDone: make(chan struct{})}
}

func (c *noisyProbeConnection) Send([]byte) error {
	c.once.Do(func() {
		go func() {
			defer close(c.producerDone)
			chunk := make([]byte, 64<<10)
			for written := 0; written < c.bytesToWrite; written += len(chunk) {
				select {
				case <-c.closed:
					return
				case c.recv <- ProcessFrame{Stderr: chunk}:
				}
			}
		}()
	})
	return nil
}
