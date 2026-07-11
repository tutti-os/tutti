package agentruntime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strings"
)

const claudeSDKStderrTailLimit = 8192

func (s *claudeSDKAdapterSession) send(request claudeSDKSidecarRequest) error {
	if s == nil || s.conn == nil {
		return ErrSessionDisconnected
	}
	if err := request.normalize(); err != nil {
		return err
	}
	data, err := json.Marshal(request)
	if err != nil {
		return err
	}
	data = append(data, '\n')
	s.sendMu.Lock()
	defer s.sendMu.Unlock()
	return s.conn.Send(data)
}

func (a *ClaudeCodeSDKAdapter) roundTripClaudeSDK(ctx context.Context, agentSessionID string, adapterSession *claudeSDKAdapterSession, request claudeSDKSidecarRequest) error {
	if adapterSession == nil {
		return ErrSessionDisconnected
	}
	if strings.TrimSpace(request.ID) == "" {
		request.ID = newID()
	}
	a.mu.Lock()
	readerStarted := adapterSession.readerStarted
	a.mu.Unlock()
	if !readerStarted {
		if err := adapterSession.send(request); err != nil {
			return err
		}
		return adapterSession.roundTripDirect(ctx, request)
	}
	response := a.registerClaudeSDKResponse(adapterSession, request.ID)
	if err := adapterSession.send(request); err != nil {
		a.unregisterClaudeSDKResponse(adapterSession, request.ID, response)
		return err
	}
	select {
	case event := <-response:
		return claudeSDKRoundTripResponseError(event)
	case <-ctx.Done():
		a.unregisterClaudeSDKResponse(adapterSession, request.ID, response)
		_ = agentSessionID
		return ctx.Err()
	}
}

func (s *claudeSDKAdapterSession) roundTripDirect(ctx context.Context, request claudeSDKSidecarRequest) error {
	if s == nil || s.reader == nil {
		return nil
	}
	for {
		event, err := s.reader.next(ctx)
		if err != nil {
			return err
		}
		if strings.TrimSpace(event.ID) != strings.TrimSpace(request.ID) {
			continue
		}
		return claudeSDKRoundTripResponseError(event)
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
				return claudeSDKSidecarEvent{}, ErrSessionDisconnected
			}
			return claudeSDKSidecarEvent{}, err
		}
		if len(frame.Stderr) > 0 {
			logClaudeSDKSidecarDebugStderr(frame.Stderr)
			r.appendStderrTail(frame.Stderr)
			continue
		}
		if frame.ExitCode != nil {
			return claudeSDKSidecarEvent{}, claudeSDKSidecarExitError(*frame.ExitCode, r.stderrTail)
		}
		if len(frame.Stdout) > 0 {
			r.buffer += string(frame.Stdout)
		}
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
		if !strings.HasPrefix(line, claudeSDKAuthRefreshLogPrefix) {
			continue
		}
		payloadJSON := strings.TrimSpace(strings.TrimPrefix(line, claudeSDKAuthRefreshLogPrefix))
		if payloadJSON == "" {
			payloadJSON = "{}"
		}
		slog.Info(claudeSDKAuthRefreshLogPrefix,
			"event", "agent_session.claude_sdk.auth_refresh_debug",
			"payload_json", payloadJSON,
		)
	}
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
