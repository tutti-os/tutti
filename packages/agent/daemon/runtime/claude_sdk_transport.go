package agentruntime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"time"

	sessionreplay "github.com/tutti-os/tutti/packages/agent/session-replay"
)

const claudeSDKStderrTailLimit = 8192

func (s *claudeSDKAdapterSession) send(request claudeSDKSidecarRequest) error {
	return s.sendContext(context.Background(), request)
}

func (s *claudeSDKAdapterSession) sendContext(ctx context.Context, request claudeSDKSidecarRequest) error {
	if s == nil || s.conn == nil {
		return ErrSessionDisconnected
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if err := request.normalize(); err != nil {
		return err
	}
	data, err := json.Marshal(request)
	if err != nil {
		return err
	}
	data = append(data, '\n')
	if !s.sendMu.TryLock() {
		ticker := time.NewTicker(time.Millisecond)
		defer ticker.Stop()
		for !s.sendMu.TryLock() {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-ticker.C:
			}
		}
	}
	defer s.sendMu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	return s.conn.Send(data)
}

func (a *ClaudeCodeSDKAdapter) roundTripClaudeSDK(ctx context.Context, agentSessionID string, adapterSession *claudeSDKAdapterSession, request claudeSDKSidecarRequest) error {
	_, err := a.roundTripClaudeSDKResponse(ctx, agentSessionID, adapterSession, request)
	return err
}

func (a *ClaudeCodeSDKAdapter) roundTripClaudeSDKResponse(ctx context.Context, agentSessionID string, adapterSession *claudeSDKAdapterSession, request claudeSDKSidecarRequest) (claudeSDKSidecarEvent, error) {
	if adapterSession == nil {
		return claudeSDKSidecarEvent{}, ErrSessionDisconnected
	}
	if strings.TrimSpace(request.ID) == "" {
		request.ID = newID()
	}
	a.mu.Lock()
	readerStarted := adapterSession.readerStarted
	a.mu.Unlock()
	if !readerStarted {
		if err := adapterSession.sendContext(ctx, request); err != nil {
			return claudeSDKSidecarEvent{}, err
		}
		return adapterSession.roundTripDirectResponse(ctx, request)
	}
	response := a.registerClaudeSDKResponse(adapterSession, request.ID)
	if err := adapterSession.sendContext(ctx, request); err != nil {
		a.unregisterClaudeSDKResponse(adapterSession, request.ID, response)
		return claudeSDKSidecarEvent{}, err
	}
	select {
	case event := <-response:
		return event, claudeSDKRoundTripResponseError(event)
	case <-ctx.Done():
		a.unregisterClaudeSDKResponse(adapterSession, request.ID, response)
		_ = agentSessionID
		return claudeSDKSidecarEvent{}, ctx.Err()
	}
}

func (s *claudeSDKAdapterSession) roundTripDirectResponse(ctx context.Context, request claudeSDKSidecarRequest) (claudeSDKSidecarEvent, error) {
	if s == nil || s.reader == nil {
		return claudeSDKSidecarEvent{}, nil
	}
	for {
		event, err := s.reader.next(ctx)
		if err != nil {
			return claudeSDKSidecarEvent{}, err
		}
		if strings.TrimSpace(event.ID) != strings.TrimSpace(request.ID) {
			if err := completeClaudeSDKProviderInputUnit(ctx, s.conn, event); err != nil {
				return claudeSDKSidecarEvent{}, err
			}
			continue
		}
		if err := completeClaudeSDKProviderInputUnit(ctx, s.conn, event); err != nil {
			return claudeSDKSidecarEvent{}, err
		}
		return event, claudeSDKRoundTripResponseError(event)
	}
}

func claudeSDKRoundTripResponseError(event claudeSDKSidecarEvent) error {
	switch event.Type {
	case "ok":
		return nil
	case "error":
		return errors.New(payloadString(event.Payload, "error"))
	default:
		return fmt.Errorf("claude sdk sidecar returned unexpected response %q", event.Type)
	}
}

func (r *claudeSDKLineReader) next(ctx context.Context) (claudeSDKSidecarEvent, error) {
	for {
		if r.trackInputUnits && len(r.lines) > 0 {
			line := r.lines[0]
			r.lines = r.lines[1:]
			var event claudeSDKSidecarEvent
			if err := json.Unmarshal([]byte(line.value), &event); err != nil {
				return claudeSDKSidecarEvent{}, err
			}
			if err := event.validate(); err != nil {
				return claudeSDKSidecarEvent{}, err
			}
			event.inputUnit = &line.unit
			return event, nil
		}
		if !r.trackInputUnits {
			if line, ok := nextBufferedLine(&r.buffer); ok {
				var event claudeSDKSidecarEvent
				if err := json.Unmarshal([]byte(line), &event); err != nil {
					return claudeSDKSidecarEvent{}, err
				}
				if err := event.validate(); err != nil {
					return claudeSDKSidecarEvent{}, err
				}
				return event, nil
			}
		}
		select {
		case <-ctx.Done():
			return claudeSDKSidecarEvent{}, ctx.Err()
		default:
		}
		var frame ProcessFrame
		var err error
		if contextual, ok := r.conn.(ContextProcessConnection); ok {
			frame, err = contextual.RecvContext(ctx)
		} else {
			frame, err = r.conn.Recv()
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				r.flushStderrDiagnostics()
				return claudeSDKSidecarEvent{}, ErrSessionDisconnected
			}
			return claudeSDKSidecarEvent{}, err
		}
		if len(frame.Stderr) > 0 {
			r.appendStderrDiagnostics(frame.Stderr)
			r.appendStderrTail(frame.Stderr)
			continue
		}
		if frame.ExitCode != nil {
			r.flushStderrDiagnostics()
			return claudeSDKSidecarEvent{}, claudeSDKSidecarExitError(*frame.ExitCode, r.stderrTail)
		}
		if len(frame.Stdout) > 0 {
			r.buffer += string(frame.Stdout)
			if !r.trackInputUnits {
				continue
			}
			var unitIndex uint64
			for {
				index := strings.IndexByte(r.buffer, '\n')
				if index < 0 {
					break
				}
				line := strings.TrimSpace(r.buffer[:index])
				r.buffer = r.buffer[index+1:]
				if line == "" {
					continue
				}
				unitIndex++
				r.lines = append(r.lines, claudeSDKBufferedLine{
					value: line,
					unit: providerInputUnit(
						frame,
						unitIndex,
						sessionreplay.ProviderInputUnitProtocolMessage,
					),
				})
			}
		}
	}
}

func completeClaudeSDKProviderInputUnit(
	ctx context.Context,
	connection ProcessConnection,
	event claudeSDKSidecarEvent,
) error {
	if event.inputUnit == nil {
		return nil
	}
	completion, ok := connection.(ProviderInputUnitCompletion)
	if !ok {
		return nil
	}
	return completion.CompleteProviderInputUnit(ctx, *event.inputUnit)
}

func nextBufferedLine(buffer *string) (string, bool) {
	if buffer == nil {
		return "", false
	}
	index := strings.IndexByte(*buffer, '\n')
	if index < 0 {
		return "", false
	}
	line := strings.TrimSpace((*buffer)[:index])
	*buffer = (*buffer)[index+1:]
	return line, line != ""
}

func (r *claudeSDKLineReader) appendStderrDiagnostics(content []byte) {
	if len(content) == 0 {
		return
	}
	r.stderrDiagnosticBuffer += string(content)
	for {
		line, ok := nextBufferedLine(&r.stderrDiagnosticBuffer)
		if !ok {
			return
		}
		logClaudeSDKSidecarDebugStderr([]byte(line))
	}
}

func (r *claudeSDKLineReader) flushStderrDiagnostics() {
	line := strings.TrimSpace(r.stderrDiagnosticBuffer)
	r.stderrDiagnosticBuffer = ""
	if line != "" {
		logClaudeSDKSidecarDebugStderr([]byte(line))
	}
}

func (r *claudeSDKLineReader) appendStderrTail(content []byte) {
	summary := claudeSDKStderrSummary(content)
	if summary == "" {
		return
	}
	r.stderrTail = append(r.stderrTail, summary...)
	r.stderrTail = append(r.stderrTail, '\n')
	if len(r.stderrTail) > claudeSDKStderrTailLimit {
		r.stderrTail = r.stderrTail[len(r.stderrTail)-claudeSDKStderrTailLimit:]
	}
}

func claudeSDKStderrSummary(content []byte) string {
	lower := strings.ToLower(string(content))
	switch {
	case strings.Contains(lower, "typeerror"), strings.Contains(lower, "syntaxerror"), strings.Contains(lower, "referenceerror"):
		return "sidecar runtime exception"
	case strings.Contains(lower, "error"), strings.Contains(lower, "failed"):
		return "sidecar runtime error"
	case strings.TrimSpace(lower) != "":
		return "sidecar diagnostic output"
	default:
		return ""
	}
}

func claudeSDKSidecarExitError(exitCode int, stderrTail []byte) error {
	if tail := strings.TrimSpace(string(stderrTail)); tail != "" {
		return fmt.Errorf("claude sdk sidecar exited with code %d: %s", exitCode, tail)
	}
	return fmt.Errorf("claude sdk sidecar exited with code %d", exitCode)
}

func logClaudeSDKSidecarDebugStderr(content []byte) {
	for _, line := range strings.Split(string(content), "\n") {
		line = strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(line, claudeSDKAuthRefreshLogPrefix):
			logClaudeSDKStructuredDiagnostic(
				line,
				claudeSDKAuthRefreshLogPrefix,
				"agent_session.claude_sdk.auth_refresh_debug",
			)
		case strings.HasPrefix(line, claudeSDKCancelLogPrefix):
			logClaudeSDKStructuredDiagnostic(
				line,
				claudeSDKCancelLogPrefix,
				"agent_session.claude_sdk.cancel_diagnostic",
			)
		case strings.HasPrefix(line, claudeSDKProviderTurnLogPrefix):
			logClaudeSDKStructuredDiagnostic(
				line,
				claudeSDKProviderTurnLogPrefix,
				"agent_session.claude_sdk.provider_turn_diagnostic",
			)
		}
	}
}

func logClaudeSDKStructuredDiagnostic(line string, prefix string, event string) {
	payloadJSON := strings.TrimSpace(strings.TrimPrefix(line, prefix))
	if !json.Valid([]byte(payloadJSON)) {
		payloadJSON = `{"stage":"invalid_diagnostic_payload"}`
	}
	var envelope struct {
		Severity string `json:"severity"`
	}
	if json.Unmarshal([]byte(payloadJSON), &envelope) == nil && envelope.Severity == "warning" {
		slog.Warn(prefix,
			"event", event,
			"payload_json", payloadJSON,
		)
		return
	}
	slog.Info(prefix,
		"event", event,
		"payload_json", payloadJSON,
	)
}
