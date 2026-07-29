package agentruntime

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
)

var (
	ErrSessionRecordingBusy     = errors.New("another agent session recording is active")
	ErrSessionRecordingNotFound = errors.New("agent session recording is not armed")
)

// SessionRecordingProcessTransport captures every provider connection in one
// root Session graph. Completing a capture detaches all writers without
// closing provider processes.
type SessionRecordingProcessTransport struct {
	base ProcessTransport

	mu          sync.Mutex
	recording   *sessionRecording
	connections map[*sessionRecordingProcessConnection]ProcessSpec
}

type sessionRecording struct {
	rootAgentSessionID string
	writer             *processCassetteWriter
	connections        map[*sessionRecordingProcessConnection]struct{}
}

func NewSessionRecordingProcessTransport(base ProcessTransport) (*SessionRecordingProcessTransport, error) {
	if base == nil {
		return nil, errors.New("session recording process transport requires a base transport")
	}
	return &SessionRecordingProcessTransport{
		base:        base,
		connections: map[*sessionRecordingProcessConnection]ProcessSpec{},
	}, nil
}

func (t *SessionRecordingProcessTransport) Arm(rootAgentSessionID, directory string) error {
	rootAgentSessionID = normalizeProcessCassetteIdentity(rootAgentSessionID)
	if rootAgentSessionID == "" {
		return errors.New("root agent session id is required")
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.recording != nil {
		return ErrSessionRecordingBusy
	}
	writer, err := newProcessCassetteWriter(directory)
	if err != nil {
		return err
	}
	t.recording = &sessionRecording{
		rootAgentSessionID: rootAgentSessionID,
		writer:             writer,
		connections:        map[*sessionRecordingProcessConnection]struct{}{},
	}
	for connection, spec := range t.connections {
		if rootProcessSessionID(spec) != rootAgentSessionID {
			continue
		}
		if err := connection.attachCapture(writer, spec); err != nil {
			for attached := range t.recording.connections {
				_ = attached.detachCapture()
			}
			t.recording = nil
			_ = writer.abort()
			return err
		}
		t.recording.connections[connection] = struct{}{}
	}
	return nil
}

func (t *SessionRecordingProcessTransport) Start(
	ctx context.Context,
	spec ProcessSpec,
) (ProcessConnection, error) {
	connection, err := t.base.Start(ctx, spec)
	if err != nil {
		return nil, err
	}

	wrapped := &sessionRecordingProcessConnection{
		base: connection,
	}
	wrapped.onClose = func() {
		t.mu.Lock()
		delete(t.connections, wrapped)
		t.mu.Unlock()
	}
	t.mu.Lock()
	t.connections[wrapped] = spec
	recording := t.recording
	if recording != nil && rootProcessSessionID(spec) == recording.rootAgentSessionID {
		if startErr := wrapped.attachCapture(recording.writer, spec); startErr != nil {
			delete(t.connections, wrapped)
			t.recording = nil
			t.mu.Unlock()
			_ = connection.Close()
			_ = recording.writer.abort()
			return nil, startErr
		}
		recording.connections[wrapped] = struct{}{}
	}
	t.mu.Unlock()
	return wrapped, nil
}

func (t *SessionRecordingProcessTransport) ReplayPlaybackState() (ReplayPlaybackState, error) {
	controller, ok := t.base.(interface {
		ReplayPlaybackState() ReplayPlaybackState
	})
	if !ok {
		return ReplayPlaybackState{}, ErrReplayPlaybackUnavailable
	}
	return controller.ReplayPlaybackState(), nil
}

func (t *SessionRecordingProcessTransport) SetReplayPlaybackSpeed(speed float64) error {
	controller, ok := t.base.(interface {
		SetReplayPlaybackSpeed(float64) error
	})
	if !ok {
		return ErrReplayPlaybackUnavailable
	}
	return controller.SetReplayPlaybackSpeed(speed)
}

func (t *SessionRecordingProcessTransport) PauseReplayPlayback() error {
	controller, ok := t.base.(interface {
		PauseReplayPlayback() error
	})
	if !ok {
		return ErrReplayPlaybackUnavailable
	}
	return controller.PauseReplayPlayback()
}

func (t *SessionRecordingProcessTransport) ResumeReplayPlayback() error {
	controller, ok := t.base.(interface {
		ResumeReplayPlayback() error
	})
	if !ok {
		return ErrReplayPlaybackUnavailable
	}
	return controller.ResumeReplayPlayback()
}

func (t *SessionRecordingProcessTransport) SetReplayPlaybackFastForward(enabled bool) error {
	controller, ok := t.base.(interface {
		SetReplayPlaybackFastForward(bool) error
	})
	if !ok {
		return ErrReplayPlaybackUnavailable
	}
	return controller.SetReplayPlaybackFastForward(enabled)
}

func (t *SessionRecordingProcessTransport) Complete(rootAgentSessionID string) error {
	recording, err := t.take(rootAgentSessionID)
	if err != nil {
		return err
	}
	if len(recording.connections) == 0 {
		_ = recording.writer.abort()
		return errors.New("agent session graph recording never opened a process connection")
	}
	for connection := range recording.connections {
		if err := connection.detachCapture(); err != nil {
			_ = recording.writer.abort()
			return err
		}
	}
	return recording.writer.finalize()
}

func (t *SessionRecordingProcessTransport) Cancel(rootAgentSessionID string) error {
	recording, err := t.take(rootAgentSessionID)
	if err != nil {
		return err
	}
	for connection := range recording.connections {
		_ = connection.detachCapture()
	}
	return recording.writer.abort()
}

// Finalize releases any unfinished dynamic capture and preserves finalization
// of a wrapped static record/replay transport.
func (t *SessionRecordingProcessTransport) Finalize() error {
	if t == nil {
		return nil
	}
	t.mu.Lock()
	recording := t.recording
	t.recording = nil
	t.mu.Unlock()

	var result error
	if recording != nil {
		for connection := range recording.connections {
			result = errors.Join(result, connection.detachCapture())
		}
		result = errors.Join(result, recording.writer.abort())
	}
	if finalizer, ok := t.base.(interface{ Finalize() error }); ok {
		result = errors.Join(result, finalizer.Finalize())
	}
	return result
}

func (t *SessionRecordingProcessTransport) take(rootAgentSessionID string) (*sessionRecording, error) {
	rootAgentSessionID = normalizeProcessCassetteIdentity(rootAgentSessionID)
	t.mu.Lock()
	defer t.mu.Unlock()
	recording := t.recording
	if recording == nil || recording.rootAgentSessionID != rootAgentSessionID {
		return nil, ErrSessionRecordingNotFound
	}
	t.recording = nil
	return recording, nil
}

func rootProcessSessionID(spec ProcessSpec) string {
	if root := normalizeProcessCassetteIdentity(spec.RootAgentSessionID); root != "" {
		return root
	}
	return normalizeProcessCassetteIdentity(spec.AgentSessionID)
}

type sessionRecordingProcessConnection struct {
	base    ProcessConnection
	onClose func()

	mu      sync.Mutex
	capture *sessionProcessCapture
}

func (c *sessionRecordingProcessConnection) attachCapture(
	writer *processCassetteWriter,
	spec ProcessSpec,
) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.capture != nil {
		return errors.New("process connection is already being recorded")
	}
	connectionID, err := writer.start(spec)
	if err != nil {
		return err
	}
	c.capture = &sessionProcessCapture{
		connectionID: connectionID,
		startedAt:    time.Now(),
		writer:       writer,
	}
	return nil
}

type sessionProcessCapture struct {
	connectionID string
	startedAt    time.Time
	writer       *processCassetteWriter
	chunkSeq     uint64
}

func (c *sessionRecordingProcessConnection) Send(data []byte) error {
	if err := c.base.Send(data); err != nil {
		return err
	}
	return c.record("outbound", data, ProcessFrame{})
}

func (c *sessionRecordingProcessConnection) Recv() (ProcessFrame, error) {
	frame, err := c.base.Recv()
	if err != nil {
		return ProcessFrame{}, err
	}
	if err := c.record("", nil, frame); err != nil {
		return ProcessFrame{}, err
	}
	return frame, nil
}

func (c *sessionRecordingProcessConnection) RecvContext(ctx context.Context) (ProcessFrame, error) {
	contextual, ok := c.base.(ContextProcessConnection)
	if !ok {
		return c.Recv()
	}
	frame, err := contextual.RecvContext(ctx)
	if err != nil {
		return ProcessFrame{}, err
	}
	if err := c.record("", nil, frame); err != nil {
		return ProcessFrame{}, err
	}
	return frame, nil
}

func (c *sessionRecordingProcessConnection) record(
	kind string,
	data []byte,
	frame ProcessFrame,
) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.capture == nil {
		return nil
	}
	c.capture.chunkSeq++
	var (
		chunk processCassetteChunk
		err   error
	)
	if kind == "outbound" {
		chunk = processCassetteChunk{
			ConnectionID: c.capture.connectionID,
			ChunkSeq:     c.capture.chunkSeq,
			ElapsedMS:    time.Since(c.capture.startedAt).Milliseconds(),
			Kind:         kind,
			Data:         base64.StdEncoding.EncodeToString(data),
		}
	} else {
		chunk, err = processCassetteFrameChunk(
			c.capture.connectionID,
			c.capture.chunkSeq,
			time.Since(c.capture.startedAt),
			frame,
		)
		if err != nil {
			return err
		}
	}
	if err := c.capture.writer.append(chunk); err != nil {
		return fmt.Errorf("record process %s chunk: %w", chunk.Kind, err)
	}
	return nil
}

func (c *sessionRecordingProcessConnection) detachCapture() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.capture == nil {
		return nil
	}
	writer := c.capture.writer
	c.capture = nil
	return writer.finishConnection()
}

func (c *sessionRecordingProcessConnection) Close() error {
	baseErr := c.base.Close()
	captureErr := c.detachCapture()
	if c.onClose != nil {
		c.onClose()
	}
	return errors.Join(baseErr, captureErr)
}

func (c *sessionRecordingProcessConnection) CloseInput() error {
	if graceful, ok := c.base.(GracefulProcessConnection); ok {
		return graceful.CloseInput()
	}
	return nil
}

func (c *sessionRecordingProcessConnection) Terminate() error {
	if graceful, ok := c.base.(GracefulProcessConnection); ok {
		return graceful.Terminate()
	}
	return c.Close()
}

func (c *sessionRecordingProcessConnection) Kill() error {
	if graceful, ok := c.base.(GracefulProcessConnection); ok {
		return graceful.Kill()
	}
	return c.Close()
}

func normalizeProcessCassetteIdentity(value string) string {
	return strings.TrimSpace(value)
}
