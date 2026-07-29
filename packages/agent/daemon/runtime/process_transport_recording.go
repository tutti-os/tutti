package agentruntime

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"sync"
	"time"
)

type RecordingProcessTransport struct {
	base   ProcessTransport
	writer *processCassetteWriter
}

func NewRecordingProcessTransport(
	base ProcessTransport,
	directory string,
) (*RecordingProcessTransport, error) {
	if base == nil {
		return nil, errors.New("recording process transport requires a base transport")
	}
	writer, err := newProcessCassetteWriter(directory)
	if err != nil {
		return nil, err
	}
	return &RecordingProcessTransport{base: base, writer: writer}, nil
}

func (t *RecordingProcessTransport) Start(
	ctx context.Context,
	spec ProcessSpec,
) (ProcessConnection, error) {
	connection, err := t.base.Start(ctx, spec)
	if err != nil {
		return nil, err
	}
	connectionID, err := t.writer.start(spec)
	if err != nil {
		_ = connection.Close()
		return nil, err
	}
	return &recordingProcessConnection{
		base:         connection,
		connectionID: connectionID,
		startedAt:    time.Now(),
		writer:       t.writer,
	}, nil
}

func (t *RecordingProcessTransport) Finalize() error {
	if t == nil || t.writer == nil {
		return nil
	}
	return t.writer.finalize()
}

type recordingProcessConnection struct {
	base         ProcessConnection
	connectionID string
	startedAt    time.Time
	writer       *processCassetteWriter

	mu        sync.Mutex
	chunkSeq  uint64
	closeOnce sync.Once
	closeErr  error
}

func (c *recordingProcessConnection) Send(data []byte) error {
	if err := c.base.Send(data); err != nil {
		return err
	}
	return c.record("outbound", base64.StdEncoding.EncodeToString(data), nil, "")
}

func (c *recordingProcessConnection) Recv() (ProcessFrame, error) {
	frame, err := c.base.Recv()
	if err != nil {
		return ProcessFrame{}, err
	}
	if err := c.recordFrame(frame); err != nil {
		return ProcessFrame{}, err
	}
	return frame, nil
}

func (c *recordingProcessConnection) RecvContext(ctx context.Context) (ProcessFrame, error) {
	contextual, ok := c.base.(ContextProcessConnection)
	if !ok {
		return c.Recv()
	}
	frame, err := contextual.RecvContext(ctx)
	if err != nil {
		return ProcessFrame{}, err
	}
	if err := c.recordFrame(frame); err != nil {
		return ProcessFrame{}, err
	}
	return frame, nil
}

func (c *recordingProcessConnection) Close() error {
	c.closeOnce.Do(func() {
		baseErr := c.base.Close()
		finishErr := c.writer.finishConnection()
		c.closeErr = errors.Join(baseErr, finishErr)
	})
	return c.closeErr
}

func (c *recordingProcessConnection) CloseInput() error {
	if graceful, ok := c.base.(GracefulProcessConnection); ok {
		return graceful.CloseInput()
	}
	return nil
}

func (c *recordingProcessConnection) Terminate() error {
	if graceful, ok := c.base.(GracefulProcessConnection); ok {
		return graceful.Terminate()
	}
	return c.Close()
}

func (c *recordingProcessConnection) Kill() error {
	if graceful, ok := c.base.(GracefulProcessConnection); ok {
		return graceful.Kill()
	}
	return c.Close()
}

func (c *recordingProcessConnection) recordFrame(frame ProcessFrame) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.chunkSeq++
	chunk, err := processCassetteFrameChunk(
		c.connectionID,
		c.chunkSeq,
		time.Since(c.startedAt),
		frame,
	)
	if err != nil {
		return err
	}
	return c.writer.append(chunk)
}

func (c *recordingProcessConnection) record(
	kind string,
	data string,
	exitCode *int,
	message string,
) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.chunkSeq++
	if err := c.writer.append(processCassetteChunk{
		ConnectionID: c.connectionID,
		ChunkSeq:     c.chunkSeq,
		ElapsedMS:    time.Since(c.startedAt).Milliseconds(),
		Kind:         kind,
		Data:         data,
		ExitCode:     exitCode,
		Message:      message,
	}); err != nil {
		return fmt.Errorf("record process %s chunk: %w", kind, err)
	}
	return nil
}
