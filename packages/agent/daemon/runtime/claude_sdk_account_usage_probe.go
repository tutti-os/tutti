package agentruntime

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

type ClaudeSDKAccountUsageProbeInput struct {
	Provider  string
	Command   []string
	Env       []string
	CWD       string
	Timeout   time.Duration
	Transport ProcessTransport
}

type ClaudeSDKAccountUsageProbeResult struct {
	Usage    map[string]any
	Duration time.Duration
	Error    error
}

// ProbeClaudeSDKAccountUsage starts the official Claude SDK sidecar, performs
// only its initialization control exchange, asks for structured account usage,
// and closes the process without yielding a model prompt.
func ProbeClaudeSDKAccountUsage(ctx context.Context, input ClaudeSDKAccountUsageProbeInput) (result ClaudeSDKAccountUsageProbeResult) {
	startedAt := time.Now()
	defer func() { result.Duration = time.Since(startedAt) }()
	if ctx == nil {
		ctx = context.Background()
	}
	if len(input.Command) == 0 || strings.TrimSpace(input.Command[0]) == "" {
		result.Error = errors.New("claude SDK sidecar command is unavailable")
		return result
	}
	timeout := input.Timeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	probeCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	transport := input.Transport
	if transport == nil {
		transport = NewLocalProcessTransport()
	}
	conn, err := transport.Start(probeCtx, ProcessSpec{
		Provider: strings.TrimSpace(input.Provider),
		Command:  append([]string(nil), input.Command...),
		Env:      append([]string(nil), input.Env...),
		CWD:      strings.TrimSpace(input.CWD),
	})
	if err != nil {
		result.Error = err
		return result
	}
	defer func() { _ = conn.Close() }()
	adapterSession := &claudeSDKAdapterSession{
		conn:   conn,
		reader: newClaudeSDKLineReader(conn, providerInputUnitsEnabled(conn)),
	}
	request := claudeSDKSidecarRequest{
		ID:   newID(),
		Type: "probe_usage",
		Payload: map[string]any{
			"cwd": strings.TrimSpace(input.CWD),
		},
	}
	if err := request.normalize(); err != nil {
		result.Error = err
		return result
	}
	encoded, err := json.Marshal(request)
	if err != nil {
		result.Error = err
		return result
	}
	if err := conn.Send(append(encoded, '\n')); err != nil {
		result.Error = err
		return result
	}
	event, err := adapterSession.roundTripDirectResponse(probeCtx, request)
	if err != nil {
		result.Error = err
		return result
	}
	if event.Payload == nil {
		result.Error = errors.New("claude SDK get_usage returned an empty response")
		return result
	}
	result.Usage = clonePayload(event.Payload)
	return result
}
