package agentruntime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand/v2"
	"strings"
	"time"
)

// CodexAppServerProbeInput is the side-effect-free subset of an app-server
// launch. It deliberately has no Session: the probe verifies only the formal
// initialize handshake and never creates a Codex thread or turn.
type CodexAppServerProbeInput struct {
	Command          []string
	Env              []string
	CWD              string
	Host             HostMetadata
	ReadAccount      bool
	ReadRateLimits   bool
	StartupTimeout   time.Duration
	HandshakeTimeout time.Duration
	ShutdownTimeout  time.Duration
	Transport        ProcessTransport
}

// CodexAppServerAccountState is the account/read authentication result. An
// unknown state means the app-server could not return a structurally valid
// account response and must not be treated as authenticated.
type CodexAppServerAccountState string

const (
	CodexAppServerAccountUnknown       CodexAppServerAccountState = "unknown"
	CodexAppServerAccountAuthenticated CodexAppServerAccountState = "authenticated"
	CodexAppServerAccountRequired      CodexAppServerAccountState = "required"
)

// CodexAppServerProbeResult keeps command-start and protocol-handshake facts
// separate. Callers must use ProtocolReady, not CommandStarted, as runtime
// capability evidence.
type CodexAppServerProbeResult struct {
	CommandStarted     bool
	ProtocolReady      bool
	AccountRead        bool
	AccountState       CodexAppServerAccountState
	AccountLabel       string
	AuthMethod         string
	RateLimitsRead     bool
	CommandCategory    string
	ProtocolCategory   string
	AccountCategory    string
	RateLimitsCategory string
	// Category is the compatibility projection of the failing stage.
	Category   string
	Message    string
	StderrTail string
	Duration   time.Duration
}

const (
	CodexProbeSpawnFailed        = "spawn_failed"
	CodexProbeStartupTimeout     = "startup_timeout"
	CodexProbeCanceled           = "probe_canceled"
	CodexProbeHandshakeTimeout   = "handshake_timeout"
	CodexProbeInvalidResponse    = "invalid_protocol_response"
	CodexProbeStdioClosed        = "stdio_closed"
	CodexProbeProtocolFailure    = "protocol_failure"
	CodexProbeUnknownRuntimeFail = "unknown_runtime_failure"
)

// ProbeCodexAppServer reuses the production ProcessTransport, JSON-RPC client,
// typed initialize request and initialized notification. ReadAccount calls the
// same account/read method used during session startup. ReadRateLimits calls
// account/rateLimits/read, which requires a provider-accepted OAuth session.
// The connection is always closed before returning; no user-facing Codex state
// is created.
func ProbeCodexAppServer(ctx context.Context, input CodexAppServerProbeInput) (result CodexAppServerProbeResult) {
	startedAt := time.Now()
	result = CodexAppServerProbeResult{
		AccountState: CodexAppServerAccountUnknown,
		Category:     CodexProbeUnknownRuntimeFail,
	}
	defer func() { result.Duration = time.Since(startedAt) }()
	if ctx == nil {
		ctx = context.Background()
	}
	if len(input.Command) == 0 || strings.TrimSpace(input.Command[0]) == "" {
		result.CommandCategory = CodexProbeSpawnFailed
		result.Category = CodexProbeSpawnFailed
		result.Message = "app-server command is unavailable"
		return result
	}
	transport := input.Transport
	if transport == nil {
		transport = NewLocalProcessTransport()
	}
	startupTimeout := input.StartupTimeout
	if startupTimeout <= 0 {
		startupTimeout = 3 * time.Second
	}
	startCtx, cancelStart := context.WithTimeout(ctx, startupTimeout)
	defer cancelStart()
	type startResult struct {
		conn ProcessConnection
		err  error
	}
	started := make(chan startResult, 1)
	go func() {
		conn, err := transport.Start(startCtx, ProcessSpec{
			Provider: "codex", Command: append([]string(nil), input.Command...),
			Env: append([]string(nil), input.Env...), CWD: input.CWD,
		})
		started <- startResult{conn: conn, err: err}
	}()
	var launch startResult
	select {
	case launch = <-started:
	case <-startCtx.Done():
		result.CommandCategory = CodexProbeStartupTimeout
		if errors.Is(startCtx.Err(), context.Canceled) {
			result.CommandCategory = CodexProbeCanceled
		}
		result.Category = result.CommandCategory
		result.Message = startCtx.Err().Error()
		// A conforming transport observes startCtx. If one returns a connection
		// late, reclaim it instead of leaving a process behind.
		go func() {
			late := <-started
			if late.conn != nil {
				closeCodexProbeConnection(late.conn, input.ShutdownTimeout)
			}
		}()
		return result
	}
	conn, err := launch.conn, launch.err
	if err != nil {
		result.CommandCategory = CodexProbeSpawnFailed
		result.Category = CodexProbeSpawnFailed
		result.Message = err.Error()
		return result
	}
	result.CommandStarted = true
	var client *codexAppServerClient
	defer func() {
		closeCodexProbeConnection(conn, input.ShutdownTimeout)
		if client == nil {
			return
		}
		select {
		case <-client.Done():
		case <-time.After(min(nonZeroDuration(input.ShutdownTimeout, 100*time.Millisecond), 100*time.Millisecond)):
		}
		diagnostics := client.Diagnostics()
		result.StderrTail = diagnostics.StderrTail
	}()

	handshakeTimeout := input.HandshakeTimeout
	if handshakeTimeout <= 0 {
		handshakeTimeout = 3 * time.Second
	}
	handshakeCtx, cancelHandshake := context.WithTimeout(ctx, handshakeTimeout)
	defer cancelHandshake()
	client = newCodexAppServerClient(conn)
	// A probe must prove that the server read this specific initialize request.
	// Keep normal session IDs deterministic, but seed this one-shot client so a
	// launcher that prints a canned response for id 1 cannot appear healthy.
	client.raw.nextID.Store(rand.Int64N(1_000_000) + 1)
	client.SetMessageHandler(func(context.Context, acpMessage) error { return nil })
	host := normalizeHostMetadata(input.Host)
	_, err = client.Initialize(handshakeCtx, handshakeTimeout, map[string]any{
		"clientInfo":   host.clientInfoParams(),
		"capabilities": map[string]any{"experimentalApi": true},
	}, func(context.Context, acpMessage) error { return nil })
	if err != nil {
		result.ProtocolCategory = codexProbeErrorCategory(handshakeCtx, err)
		result.Category = result.ProtocolCategory
		result.Message = err.Error()
		return result
	}
	if err := client.Initialized(handshakeCtx); err != nil {
		result.ProtocolCategory = codexProbeErrorCategory(handshakeCtx, err)
		result.Category = result.ProtocolCategory
		result.Message = err.Error()
		return result
	}
	result.ProtocolReady = true
	// Keep this result invariant explicit for callers which only retain the
	// final protocol fact.
	result.CommandStarted = true
	result.Category = ""
	if input.ReadAccount {
		accountRaw, err := client.AccountRead(handshakeCtx, handshakeTimeout, map[string]any{},
			func(context.Context, acpMessage) error { return nil })
		if err != nil {
			result.AccountCategory = codexProbeErrorCategory(handshakeCtx, err)
			result.Category = result.AccountCategory
			result.Message = err.Error()
			return result
		}
		account, ok := parseCodexProbeAccount(accountRaw)
		if !ok {
			result.AccountCategory = CodexProbeInvalidResponse
			result.Category = result.AccountCategory
			result.Message = "account/read returned an invalid account response"
			return result
		}
		result.AccountRead = true
		result.AccountState = account.State
		result.AccountLabel = account.Label
		result.AuthMethod = account.AuthMethod
	}
	if input.ReadRateLimits {
		if _, err := client.AccountRateLimitsRead(
			handshakeCtx,
			handshakeTimeout,
			func(context.Context, acpMessage) error { return nil },
		); err != nil {
			result.RateLimitsCategory = codexProbeErrorCategory(handshakeCtx, err)
			result.Category = result.RateLimitsCategory
			result.Message = err.Error()
			return result
		}
		result.RateLimitsRead = true
	}
	return result
}

type codexProbeAccount struct {
	State      CodexAppServerAccountState
	Label      string
	AuthMethod string
}

func parseCodexProbeAccount(raw json.RawMessage) (codexProbeAccount, bool) {
	var payload struct {
		Account            map[string]any `json:"account"`
		RequiresOpenaiAuth *bool          `json:"requiresOpenaiAuth"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil || payload.RequiresOpenaiAuth == nil {
		return codexProbeAccount{}, false
	}
	if payload.Account == nil {
		if *payload.RequiresOpenaiAuth {
			return codexProbeAccount{State: CodexAppServerAccountRequired}, true
		}
		return codexProbeAccount{State: CodexAppServerAccountUnknown}, true
	}
	authMethod := strings.TrimSpace(asString(payload.Account["type"]))
	switch authMethod {
	case "chatgpt":
		if strings.TrimSpace(asString(payload.Account["planType"])) == "" {
			return codexProbeAccount{}, false
		}
	case "apiKey", "amazonBedrock":
	default:
		return codexProbeAccount{}, false
	}
	return codexProbeAccount{
		State:      CodexAppServerAccountAuthenticated,
		Label:      strings.TrimSpace(asString(payload.Account["email"])),
		AuthMethod: authMethod,
	}, true
}

func closeCodexProbeConnection(conn ProcessConnection, _ time.Duration) {
	if conn == nil {
		return
	}
	_ = conn.Close()
}

func nonZeroDuration(value, fallback time.Duration) time.Duration {
	if value > 0 {
		return value
	}
	return fallback
}

func codexProbeErrorCategory(ctx context.Context, err error) string {
	if errors.Is(ctx.Err(), context.Canceled) {
		return CodexProbeCanceled
	}
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return CodexProbeHandshakeTimeout
	}
	message := strings.ToLower(fmt.Sprint(err))
	switch {
	case strings.Contains(message, "unexpected end"), strings.Contains(message, "eof"), strings.Contains(message, "closed"):
		return CodexProbeStdioClosed
	case strings.Contains(message, "invalid character"), strings.Contains(message, "json"),
		strings.Contains(message, "invalid") && strings.Contains(message, "stdout"):
		return CodexProbeInvalidResponse
	default:
		return CodexProbeProtocolFailure
	}
}
